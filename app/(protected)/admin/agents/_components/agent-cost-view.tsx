"use client"

import { useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type { AgentCostSummary } from "@/actions/admin/agent-cost.actions"
import type {
  AgentCostByModel,
  AgentCostProjection,
  PricableModel,
} from "@/actions/admin/agent-cost-projection.actions"
import { AGENT_MODEL_LABEL } from "@/lib/agents/platform-model"
import { formatUsd } from "@/lib/utils/format-currency"

interface Props {
  /** Token×pricing actual cost (source of truth). */
  costByModel: AgentCostByModel | null
  /** Model-switch projection. */
  projection: AgentCostProjection | null
  /** Candidate models available for projection. */
  pricableModels: PricableModel[]
  /** AWS Cost Explorer summary (reconciliation only). */
  costExplorer: AgentCostSummary | null
  /** Currently selected candidate model for the projection panel. */
  selectedCandidate: string | null
  onSelectCandidate: (modelId: string) => void
  loading?: boolean
}

// Agent spend can be sub-cent; show 4 decimals so small but real cost doesn't
// round to $0.00 and read as "free".
const usd = (n: number) => formatUsd(n, 4)

const fmtInt = (n: number) => new Intl.NumberFormat("en-US").format(n)

export function AgentCostView({
  costByModel,
  projection,
  pricableModels,
  costExplorer,
  selectedCandidate,
  onSelectCandidate,
  loading = false,
}: Props) {
  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <ModelCostPanel costByModel={costByModel} />
      <ProjectionPanel
        projection={projection}
        pricableModels={pricableModels}
        selectedCandidate={selectedCandidate}
        onSelectCandidate={onSelectCandidate}
      />
      <ReconciliationPanel costExplorer={costExplorer} />
    </div>
  )
}

// ---------- Source of truth: token × pricing ----------

function ModelCostPanel({ costByModel }: { costByModel: AgentCostByModel | null }) {
  // Distinguish a load FAILURE from a genuinely empty window. The client sets
  // costByModel to null (and fires an error toast) ONLY when getAgentCostByModel
  // threw; a successful-but-empty window is a real object with an empty byModel
  // array. Collapsing both into "no usage" hides infra errors and reads as
  // "$0 spend" — the null-for-both-error-and-empty anti-pattern called out in
  // docs/guides/silent-failure-patterns.md. The sibling CostExplorerPanel below
  // already draws this distinction (`if (!data)`); carry it here too.
  if (!costByModel) {
    return (
      <div>
        <h3 className="text-sm font-semibold mb-1">
          Model cost (tokens × pricing)
        </h3>
        <Card>
          <CardContent className="pt-6">
            <EmptyRow text="Model cost data unavailable — the query failed to load (see the error notification). This is NOT a $0 reading; retry the range." />
          </CardContent>
        </Card>
      </div>
    )
  }

  const totalUsd = costByModel.totalUsd
  const windowDays = costByModel.windowDays
  const hasTokenData = costByModel.byModel.some(
    (m) => m.inputTokens + m.outputTokens > 0
  )
  const missing = costByModel.modelsMissingPricing

  return (
    <div>
      <h3 className="text-sm font-semibold mb-1">Model cost (tokens × pricing)</h3>
      <p className="text-xs text-muted-foreground mb-3">
        Source of truth for model spend. Computed from the real token volume
        recorded per message multiplied by current{" "}
        <code className="text-[11px]">ai_models</code> pricing. Cost is{" "}
        <span className="font-medium">cache-aware</span> (issue #1089): cache
        reads are priced at the cached-input rate (~0.1&times; input) and cache
        writes at the cache-write rate, on top of full-price input/output.
        Bedrock Mantle spend does not flow through Cost Explorer, so this is the
        authoritative model-cost view.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <SummaryStat
          label={`Model spend${windowDays ? ` (${windowDays}d)` : ""}`}
          value={usd(totalUsd)}
        />
        <SummaryStat
          label="Avg / day"
          value={usd(windowDays && windowDays > 0 ? totalUsd / windowDays : 0)}
        />
        <SummaryStat
          label="Projected 30d"
          value={usd(
            windowDays && windowDays > 0 ? (totalUsd / windowDays) * 30 : 0
          )}
        />
      </div>

      {missing.length > 0 && (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          No pricing row in <code className="text-[11px]">ai_models</code> for:{" "}
          <span className="font-mono">{missing.join(", ")}</span>. Cost for these
          models reads as $0 until a pricing row is added.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By model</CardTitle>
        </CardHeader>
        <CardContent>
          {!hasTokenData ? (
            <EmptyRow text="No token usage recorded in this window." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Messages</TableHead>
                  <TableHead className="text-right">Input tok</TableHead>
                  <TableHead className="text-right">Output tok</TableHead>
                  <TableHead className="text-right">Cache read tok</TableHead>
                  <TableHead className="text-right">Cache write tok</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {costByModel.byModel.map((m) => {
                  const flagMissing =
                    m.pricingMissing && m.inputTokens + m.outputTokens > 0
                  return (
                    <TableRow key={m.model}>
                      <TableCell className="font-mono text-xs">
                        {m.model}
                        {flagMissing && <NoPricingBadge />}
                      </TableCell>
                      <TableCell className="text-right">
                        {fmtInt(m.messageCount)}
                      </TableCell>
                      <TableCell className="text-right">
                        {fmtInt(m.inputTokens)}
                      </TableCell>
                      <TableCell className="text-right">
                        {fmtInt(m.outputTokens)}
                      </TableCell>
                      <TableCell className="text-right">
                        {m.cacheReadTokens > 0 ? fmtInt(m.cacheReadTokens) : <Dash />}
                      </TableCell>
                      <TableCell className="text-right">
                        {m.cacheWriteTokens > 0 ? fmtInt(m.cacheWriteTokens) : <Dash />}
                      </TableCell>
                      <TableCell className="text-right">
                        {m.pricingMissing ? <Dash /> : usd(m.usd)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ---------- Model-switch projection ----------

function ProjectionPanel({
  projection,
  pricableModels,
  selectedCandidate,
  onSelectCandidate,
}: {
  projection: AgentCostProjection | null
  pricableModels: PricableModel[]
  selectedCandidate: string | null
  onSelectCandidate: (modelId: string) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Model-switch projection</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          What the same token volume (
          {projection ? fmtInt(projection.actualInputTokens) : "0"} in /{" "}
          {projection ? fmtInt(projection.actualOutputTokens) : "0"} out) would
          cost on a different model. Input counts the full prompt including
          cached tokens (a non-caching model reprocesses all of them), so this
          assumes no caching on the candidate.
        </p>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Compare to:</span>
          <Select
            value={selectedCandidate ?? undefined}
            onValueChange={onSelectCandidate}
          >
            <SelectTrigger className="w-[280px] h-8 text-sm">
              <SelectValue placeholder="Select a model…" />
            </SelectTrigger>
            <SelectContent>
              {pricableModels.map((m) => (
                <SelectItem key={m.modelId} value={m.modelId}>
                  {m.name} ({m.modelId})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {projection && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scenario</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">vs. actual</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">
                  Actual ({AGENT_MODEL_LABEL})
                </TableCell>
                <TableCell className="text-right">
                  {usd(projection.actualUsd)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  —
                </TableCell>
              </TableRow>
              {projection.candidates.map((c) => (
                <ProjectionRow
                  key={c.model}
                  candidate={c}
                  actualUsd={projection.actualUsd}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function ProjectionRow({
  candidate,
  actualUsd,
}: {
  candidate: AgentCostProjection["candidates"][number]
  actualUsd: number
}) {
  const delta = candidate.usd - actualUsd
  const deltaClass = candidate.pricingMissing
    ? "text-muted-foreground"
    : delta > 0
      ? "text-red-600"
      : "text-green-600"
  return (
    <TableRow>
      <TableCell>
        {candidate.name}
        {candidate.pricingMissing && <NoPricingBadge />}
      </TableCell>
      <TableCell className="text-right">
        {candidate.pricingMissing ? <Dash /> : usd(candidate.usd)}
      </TableCell>
      <TableCell className={`text-right ${deltaClass}`}>
        {candidate.pricingMissing
          ? "—"
          : `${delta >= 0 ? "+" : ""}${usd(delta)}`}
      </TableCell>
    </TableRow>
  )
}

// ---------- Cost Explorer reconciliation (secondary) ----------

function ReconciliationPanel({
  costExplorer,
}: {
  costExplorer: AgentCostSummary | null
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          AWS-billed infrastructure (Cost Explorer reconciliation)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          Reconciliation only — NOT model cost. This panel reflects AgentCore /
          infrastructure spend tagged{" "}
          <code className="text-[11px]">costCenter=ai-agents</code> on the
          execution role. The harness model spend (Claude Sonnet 5 as of #1089)
          runs through Bedrock Mantle under a separate IAM user&apos;s bearer
          token, so it does <span className="font-medium">not</span> carry this
          tag and will not appear here. Use the token×pricing view above for
          model cost.
        </p>
        <CostExplorerPanel data={costExplorer} />
      </CardContent>
    </Card>
  )
}

function CostExplorerPanel({ data }: { data: AgentCostSummary | null }) {
  const dailyData = useMemo(() => data?.daily ?? [], [data])

  if (!data) {
    return (
      <EmptyRow text="Cost Explorer data unavailable. Confirm the ECS task role has ce:GetCostAndUsage and that the costCenter tag is activated in Billing." />
    )
  }

  const noActivity = dailyData.length === 0 || data.totalUsd === 0

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryStat
          label={`Infra spend (${data.windowDays}d)`}
          value={usd(data.totalUsd)}
        />
        <SummaryStat
          label="Avg / day"
          value={usd(data.windowDays > 0 ? data.totalUsd / data.windowDays : 0)}
        />
        <SummaryStat label="Projected 30d" value={usd(data.projectedMonthlyUsd)} />
      </div>

      {noActivity ? (
        <div className="h-32 flex flex-col items-center justify-center gap-2 text-sm">
          <div className="text-muted-foreground">
            No billed infrastructure activity in window.
          </div>
          <div className="text-xs text-muted-foreground max-w-lg text-center">
            If you expect spend here, the most common cause is that{" "}
            <code className="text-[11px]">costCenter</code> is not yet activated
            as a cost-allocation tag. Activate it in{" "}
            <a
              className="underline"
              target="_blank"
              rel="noopener noreferrer"
              href="https://us-east-1.console.aws.amazon.com/billing/home#/tags"
            >
              Billing → Cost allocation tags
            </a>
            ; new spend appears ~24h later.
          </div>
        </div>
      ) : (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={dailyData}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
              />
              <Tooltip formatter={(v) => usd(Number(v ?? 0))} />
              <Area
                type="monotone"
                dataKey="usd"
                stroke="hsl(var(--primary))"
                fill="hsl(var(--primary))"
                fillOpacity={0.2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

// ---------- Small shared bits ----------

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="text-2xl font-semibold mt-1">{value}</div>
      </CardContent>
    </Card>
  )
}

function NoPricingBadge() {
  return (
    <Badge
      variant="outline"
      className="ml-2 text-[10px] border-amber-400 text-amber-700"
    >
      no pricing
    </Badge>
  )
}

function Dash() {
  return <span className="text-muted-foreground">—</span>
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="h-16 flex items-center justify-center text-muted-foreground text-sm">
      {text}
    </div>
  )
}
