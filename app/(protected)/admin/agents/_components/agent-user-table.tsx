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
import { formatDate } from "@/lib/date-utils"
import type { UserUsageItem } from "@/actions/admin/agent-telemetry.actions"

interface AgentUserTableProps {
  data: UserUsageItem[]
  loading?: boolean
}

export function AgentUserTable({ data, loading = false }: AgentUserTableProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">User Adoption</CardTitle>
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
          <CardTitle className="text-base">User Adoption</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-32 flex items-center justify-center text-muted-foreground">
            No user data available
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">User Adoption (Top 25)</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead className="text-right">Messages</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Sessions</TableHead>
              <TableHead className="text-right">Last Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((item) => (
              <TableRow key={item.userId}>
                <TableCell className="font-medium text-sm">
                  {item.userId}
                </TableCell>
                <TableCell className="text-right">
                  {item.messageCount.toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  {item.totalTokens.toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  {item.sessionCount.toLocaleString()}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {formatDate(item.lastActive, true)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
