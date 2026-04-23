"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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

interface Props {
  data: AgentCostSummary | null
  loading?: boolean
}

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n)

export function AgentCostView({ data, loading = false }: Props) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent Platform Cost</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent Platform Cost</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
            Cost data unavailable. Confirm the ECS task role has ce:GetCostAndUsage and that Bedrock invocations are tagged costCenter=ai-agents.
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Spend ({data.windowDays}d)
            </div>
            <div className="text-2xl font-semibold mt-1">{usd(data.totalUsd)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Avg / day</div>
            <div className="text-2xl font-semibold mt-1">
              {usd(data.windowDays > 0 ? data.totalUsd / data.windowDays : 0)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Projected 30d
            </div>
            <div className="text-2xl font-semibold mt-1">{usd(data.projectedMonthlyUsd)}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily spend (Cost Explorer, costCenter=ai-agents)</CardTitle>
        </CardHeader>
        <CardContent>
          {data.daily.length === 0 ? (
            <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
              No billed activity in window.
            </div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.daily}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Number(v).toFixed(2)}`} />
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By usage type</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byModel.length === 0 ? (
            <div className="h-16 flex items-center justify-center text-muted-foreground text-sm">
              No breakdown available.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Usage type</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byModel.map((m) => (
                  <TableRow key={m.model}>
                    <TableCell className="font-mono text-xs">{m.model}</TableCell>
                    <TableCell className="text-right">{usd(m.usd)}</TableCell>
                    <TableCell className="text-right text-muted-foreground text-sm">
                      {data.totalUsd > 0 ? ((m.usd / data.totalUsd) * 100).toFixed(1) : "0.0"}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
