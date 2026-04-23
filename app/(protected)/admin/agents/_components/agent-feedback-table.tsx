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
import { formatDate } from "@/lib/date-utils"
import type { FeedbackItem } from "@/actions/admin/agent-telemetry.actions"

interface AgentFeedbackTableProps {
  data: FeedbackItem[]
  loading?: boolean
}

export function AgentFeedbackTable({ data, loading = false }: AgentFeedbackTableProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">User Feedback</CardTitle>
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
          <CardTitle className="text-base">User Feedback</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-32 flex items-center justify-center text-muted-foreground">
            No feedback data available
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">User Feedback</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Message ID</TableHead>
              <TableHead>Rating</TableHead>
              <TableHead className="text-right">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-medium text-sm">
                  {item.userId}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {item.messageId}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={item.thumbsUp ? "default" : "destructive"}
                    className="text-xs"
                  >
                    {item.thumbsUp ? "Positive" : "Negative"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {formatDate(item.createdAt, true)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
