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
import type { AgentPatternRow } from "@/actions/admin/agent-health.actions"

interface Props {
  data: AgentPatternRow[]
  loading?: boolean
}

export function AgentPatternsTable({ data, loading = false }: Props) {
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
        {data.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
            No patterns detected yet. The weekly scanner runs on a recurring schedule.
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
              {data.map((r) => (
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
