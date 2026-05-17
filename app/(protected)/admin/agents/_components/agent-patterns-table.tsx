"use client"

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
import type {
  AgentPatternRow,
  AgentPatternsEnvelope,
} from "@/actions/admin/agent-health.actions"
import { formatDate } from "@/lib/date-utils"

interface Props {
  data: AgentPatternsEnvelope
  loading?: boolean
}

export function AgentPatternsTable({ data, loading = false }: Props) {
  const rows: AgentPatternRow[] = data.rows
  const lastScan = data.lastScan
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organizational Patterns</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Organizational Patterns</CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Cross-building topic convergence detected weekly. Privacy: no user identity or message content stored.
          Patterns suppressed below 3 signals / 2 buildings.
        </p>
      </CardHeader>
      <CardContent>
        {lastScan && (
          <div className="text-xs text-muted-foreground mb-3 border rounded p-2 bg-muted/30">
            <span className="font-medium">Last scan:</span>{" "}
            {formatDate(lastScan.runAt, true)} · week {lastScan.week} ·{" "}
            {lastScan.signalsTotal} signals · {lastScan.topicsTotal} topics ·{" "}
            <span className="text-foreground">{lastScan.detected} detected</span>
            {lastScan.suppressed > 0 && ` · ${lastScan.suppressed} suppressed`}
          </div>
        )}
        {rows.length === 0 ? (
          <div className="h-40 flex flex-col items-center justify-center gap-2 text-sm">
            <div className="text-muted-foreground">
              {lastScan
                ? "Scanner ran but no patterns met the suppression threshold."
                : "Pattern scanner has not run yet."}
            </div>
            <div className="text-xs text-muted-foreground max-w-md text-center">
              Scanner runs Sundays 23:00 UTC. Patterns are suppressed below 3
              signals / 2 buildings (privacy guarantee). If{" "}
              <code className="text-[11px]">agent_pattern_scan_runs</code>{" "}
              stays empty despite agent_messages activity, the Lambda is
              likely failing silently — check CloudWatch logs.
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Week</TableHead>
                <TableHead>Topic</TableHead>
                <TableHead className="text-right">Signals</TableHead>
                <TableHead className="text-right">Buildings</TableHead>
                <TableHead className="text-right">4-wk avg</TableHead>
                <TableHead className="text-right">Spike</TableHead>
                <TableHead>Buildings seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.week}:${r.topic}`}>
                  <TableCell className="font-mono text-xs">{r.week}</TableCell>
                  <TableCell className="font-medium text-sm">
                    {r.topic}
                    {r.isEmerging && (
                      <Badge variant="default" className="ml-2">
                        emerging
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{r.signalCount}</TableCell>
                  <TableCell className="text-right">{r.buildingCount}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {r.rollingAvg.toFixed(1)}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.isEmerging ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Badge variant="secondary">{r.spikeRatio.toFixed(1)}×</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.buildings}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
