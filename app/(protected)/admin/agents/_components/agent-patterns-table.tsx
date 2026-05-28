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
          <div className="h-44 flex flex-col items-center justify-center gap-2 text-sm">
            {!lastScan && (
              <>
                <div className="text-muted-foreground">
                  Pattern scanner has not run yet.
                </div>
                <div className="text-xs text-muted-foreground max-w-md text-center">
                  Scanner is scheduled for Sundays 23:00 UTC via EventBridge.
                  If <code className="text-[11px]">agent_pattern_scan_runs</code>{" "}
                  stays empty after the next Sunday, check the Lambda&apos;s
                  CloudWatch logs.
                </div>
              </>
            )}
            {lastScan && lastScan.signalsTotal === 0 && (
              <>
                <div className="text-muted-foreground">
                  Scanner ran cleanly but the signal store was empty.
                </div>
                <div className="text-xs text-muted-foreground max-w-lg text-center">
                  The topic classifier produced no signals from recent agent
                  traffic. This means the K-12 admin keyword taxonomy in{" "}
                  <code className="text-[11px]">topic-classifier.ts</code>{" "}
                  didn&apos;t match any messages — typical when most traffic is
                  developer / system testing rather than school operations.
                  Expand the keyword patterns to broaden coverage, or wait
                  until production K-12 traffic builds up.
                </div>
              </>
            )}
            {lastScan && lastScan.signalsTotal > 0 && (
              <>
                <div className="text-muted-foreground">
                  Scanner ran. {lastScan.signalsTotal} signals classified but
                  no cross-building patterns met the 3-signal / 2-building
                  suppression threshold.
                </div>
                <div className="text-xs text-muted-foreground max-w-md text-center">
                  Privacy floor — patterns only surface when at least 3 signals
                  span at least 2 buildings in the same week. Below that we
                  consider them potentially identifying.
                </div>
              </>
            )}
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
