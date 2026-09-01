"use client"

/**
 * Atrium usage dashboard — the Usage tab of /admin/atrium (administrators).
 *
 * Answers "who is using Atrium, for what, and where" from the content audit
 * trail: headline authoring counts with 24h/7d deltas, human-vs-agent and
 * per-surface splits, the current inventory, a daily activity strip, and
 * the most active authors, agents and sections for a selectable range.
 *
 * The trail is MUTATION-only (see `getAtriumUsageStatsAction`), so this shows
 * authoring and organizing activity, never reads — the panel says so, rather
 * than letting a "views" column be assumed.
 */

import { useState, useTransition } from "react"
import {
  getAtriumUsageStatsAction,
  type AtriumUsageRange,
  type AtriumUsageStats,
} from "@/actions/db/atrium/usage-stats"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { meridianPortalClassName } from "@/lib/meridian/fonts"

const RANGES: { value: AtriumUsageRange; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
]

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%"
  return `${Math.round((part / whole) * 100)}%`
}

function Tile({
  label,
  value,
  sub,
  testId,
}: {
  label: string
  value: number | string
  sub?: string
  testId: string
}) {
  return (
    <Card data-testid={testId}>
      <CardContent>
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-bold">
          {typeof value === "number" ? value.toLocaleString() : value}
        </p>
        {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  )
}

/** The headline tiles: what happened in the range, and who did it. */
function UsageTiles({ stats }: { stats: AtriumUsageStats }) {
  const mutations = stats.actors.human + stats.actors.agent
  const surfaces = stats.surfaces
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Tile
          testId="usage-tile-created"
          label="Created"
          value={stats.totals.created}
          sub={`${stats.last24h.created} today · ${stats.last7d.created} this week`}
        />
        <Tile
          testId="usage-tile-updated"
          label="Updated"
          value={stats.totals.updated}
          sub={`${stats.last24h.updated} today · ${stats.last7d.updated} this week`}
        />
        <Tile
          testId="usage-tile-published"
          label="Published"
          value={stats.totals.published}
          sub={`${stats.last24h.published} today · ${stats.last7d.published} this week`}
        />
        <Tile
          testId="usage-tile-authors"
          label="Active authors"
          value={stats.activeAuthors7d}
          sub={`last 7 days · ${stats.activeAuthorsRange} in range`}
        />
        <Tile
          testId="usage-tile-agents"
          label="Agent share"
          value={pct(stats.actors.agent, mutations)}
          sub={`${stats.actors.agent.toLocaleString()} of ${mutations.toLocaleString()} changes · ${stats.activeAgentsRange} agents`}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          testId="usage-tile-inventory"
          label="Library today"
          value={stats.inventory.objects}
          sub={`${stats.inventory.published} published · ${stats.inventory.drafts} drafts · ${stats.inventory.archived} archived · ${stats.inventory.collections} sections`}
        />
        <Tile
          testId="usage-tile-kinds"
          label="Objects touched"
          value={stats.kinds.document + stats.kinds.artifact}
          sub={`${stats.kinds.document} docs · ${stats.kinds.artifact} artifacts`}
        />
        <Tile
          testId="usage-tile-surfaces"
          label="Where changes came from"
          value={`${pct(surfaces.ui, mutations)} in-app`}
          sub={`${surfaces.ui} app · ${surfaces.mcp} agent (MCP) · ${surfaces.rest} API`}
        />
        <Tile
          testId="usage-tile-errors"
          label="Failed attempts"
          value={stats.errorsRange}
          sub={`${stats.totals.unpublished} unpublished · ${stats.totals.deleted} deleted · ${stats.totals.collections} section changes`}
        />
      </div>
    </>
  )
}

/** A dependency-free daily activity strip; exact numbers in the table below it. */
function DailyActivity({ stats }: { stats: AtriumUsageStats }) {
  const max = Math.max(
    1,
    ...stats.daily.map((d) => d.created + d.updated + d.published)
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Daily activity</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="flex h-24 items-end gap-[2px]"
          role="img"
          aria-label={`Daily changes over the last ${stats.daily.length} days`}
          data-testid="usage-daily-strip"
        >
          {stats.daily.map((d) => {
            const total = d.created + d.updated + d.published
            return (
              <div
                key={d.day}
                className="flex-1 rounded-t bg-[var(--mer-brand,#2563eb)]/70"
                style={{ height: `${Math.max(2, (total / max) * 100)}%` }}
                title={`${d.day}: ${d.created} created, ${d.updated} updated, ${d.published} published`}
              />
            )
          })}
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Show daily numbers
          </summary>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead className="text-right">Created</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead className="text-right">Published</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...stats.daily].reverse().map((d) => (
                <TableRow key={d.day}>
                  <TableCell>{d.day}</TableCell>
                  <TableCell className="text-right">{d.created}</TableCell>
                  <TableCell className="text-right">{d.updated}</TableCell>
                  <TableCell className="text-right">{d.published}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      </CardContent>
    </Card>
  )
}

function CountsTable({
  title,
  testId,
  rows,
  emptyText,
}: {
  title: string
  testId: string
  rows: { key: string; label: string; detail?: string | null; created: number; updated: number; published: number; total: number }[]
  emptyText: string
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Created</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead className="text-right">Published</TableHead>
                <TableHead className="text-right">All changes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <span className="font-medium">{row.label}</span>
                    {row.detail && (
                      <span className="ml-2 text-xs text-muted-foreground">{row.detail}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{row.created}</TableCell>
                  <TableCell className="text-right">{row.updated}</TableCell>
                  <TableCell className="text-right">{row.published}</TableCell>
                  <TableCell className="text-right font-medium">{row.total}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function SectionsTable({ stats }: { stats: AtriumUsageStats }) {
  return (
    <Card data-testid="usage-sections">
      <CardHeader>
        <CardTitle className="text-base">Most active sections</CardTitle>
      </CardHeader>
      <CardContent>
        {stats.topSections.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No changes to filed content in this range.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Section</TableHead>
                <TableHead className="text-right">Changes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.topSections.map((s) => (
                <TableRow key={s.collectionId}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-right">{s.total}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

interface AtriumUsagePanelProps {
  initialStats: AtriumUsageStats | null
  initialError: string | null
}

export function AtriumUsagePanel({ initialStats, initialError }: AtriumUsagePanelProps) {
  const [range, setRange] = useState<AtriumUsageRange>(initialStats?.range ?? "30d")
  const [stats, setStats] = useState<AtriumUsageStats | null>(initialStats)
  const [error, setError] = useState<string | null>(initialError)
  const [isPending, startTransition] = useTransition()

  const load = (next: AtriumUsageRange) => {
    setRange(next)
    startTransition(async () => {
      const res = await getAtriumUsageStatsAction(next)
      if (res.isSuccess) {
        setStats(res.data)
        setError(null)
      } else {
        setError(res.message ?? "Failed to load usage")
      }
    })
  }

  return (
    <div className="space-y-4" data-testid="atrium-usage-panel" aria-busy={isPending}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Authoring, publishing and organizing activity from the content audit
          trail. Atrium records changes, not views — reading activity is not
          tracked.
        </p>
        <Select value={range} onValueChange={(v) => load(v as AtriumUsageRange)}>
          <SelectTrigger className="w-[160px]" aria-label="Usage range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={meridianPortalClassName}>
            {RANGES.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {stats && (
        <>
          <UsageTiles stats={stats} />
          <DailyActivity stats={stats} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <CountsTable
              title="Most active people"
              testId="usage-authors"
              emptyText="No changes by people in this range."
              rows={stats.topAuthors.map((a) => ({
                key: String(a.userId),
                label: a.name,
                detail: a.email,
                created: a.created,
                updated: a.updated,
                published: a.published,
                total: a.total,
              }))}
            />
            <CountsTable
              title="Most active agents"
              testId="usage-agents"
              emptyText="No agent changes in this range."
              rows={stats.topAgents.map((a) => ({
                key: a.label,
                label: a.label,
                created: a.created,
                updated: a.updated,
                published: a.published,
                total: a.total,
              }))}
            />
          </div>
          <SectionsTable stats={stats} />
        </>
      )}
    </div>
  )
}
