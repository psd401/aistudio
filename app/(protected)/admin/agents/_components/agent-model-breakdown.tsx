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
import type { ModelBreakdownItem } from "@/actions/admin/agent-telemetry.actions"

interface AgentModelBreakdownProps {
  data: ModelBreakdownItem[]
  loading?: boolean
}

export function AgentModelBreakdown({ data, loading = false }: AgentModelBreakdownProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Model Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Model Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-32 flex items-center justify-center text-muted-foreground">
            No model data available
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Model Breakdown</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Messages</TableHead>
              <TableHead className="text-right">Total Tokens</TableHead>
              <TableHead className="text-right">Avg Latency</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((item) => (
              <TableRow key={item.model}>
                <TableCell className="font-medium text-sm">
                  {item.model}
                </TableCell>
                <TableCell className="text-right">
                  {item.messageCount.toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  {item.totalTokens.toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  {item.avgLatencyMs > 1000
                    ? `${(item.avgLatencyMs / 1000).toFixed(1)}s`
                    : `${item.avgLatencyMs}ms`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
