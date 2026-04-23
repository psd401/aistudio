"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
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
import { formatDate } from "@/lib/date-utils"
import type { GuardrailEvent } from "@/actions/admin/agent-telemetry.actions"

interface AgentSafetyTableProps {
  data: GuardrailEvent[]
  loading?: boolean
}

export function AgentSafetyTable({ data, loading = false }: AgentSafetyTableProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Guardrail Flags</CardTitle>
          <CardDescription>
            Telemetry-only flags -- no messages were blocked
          </CardDescription>
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
          <CardTitle className="text-base">Guardrail Flags</CardTitle>
          <CardDescription>
            Telemetry-only flags -- no messages were blocked
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-32 flex items-center justify-center text-muted-foreground">
            No guardrail flags in this period
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Guardrail Flags</CardTitle>
        <CardDescription>
          Telemetry-only flags -- no messages were blocked. These indicate messages
          that <em>would have</em> been flagged by Bedrock Guardrails.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Space</TableHead>
              <TableHead className="text-right">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((event) => (
              <TableRow key={event.id}>
                <TableCell className="text-sm text-muted-foreground">
                  {event.id}
                </TableCell>
                <TableCell className="font-medium text-sm">
                  {event.userId}
                </TableCell>
                <TableCell className="text-sm">
                  {event.model ?? (
                    <Badge variant="secondary" className="text-xs">
                      unknown
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {event.spaceName ?? "-"}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {formatDate(event.createdAt, true)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
