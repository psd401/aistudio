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
import type { AgentHealthSummary } from "@/actions/admin/agent-health.actions"

interface Props {
  data: AgentHealthSummary | null
  loading?: boolean
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function AgentHealthTable({ data, loading = false }: Props) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent Health</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (!data || data.rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent Health</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
            {data?.snapshotDate
              ? "No snapshots recorded yet."
              : "Daily health Lambda has not run yet."}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Active Agents</div>
            <div className="text-2xl font-semibold mt-1">{data.totalUsers}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Abandoned (7d+)</div>
            <div className="text-2xl font-semibold mt-1">{data.abandonedCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Total Skills</div>
            <div className="text-2xl font-semibold mt-1">{data.totalSkills}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Total Workspace</div>
            <div className="text-2xl font-semibold mt-1">{formatBytes(data.totalWorkspaceBytes)}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Per-user Health (snapshot {data.snapshotDate})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Objects</TableHead>
                <TableHead className="text-right">Skills</TableHead>
                <TableHead className="text-right">Memory files</TableHead>
                <TableHead className="text-right">Last activity</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r) => (
                <TableRow key={r.userEmail}>
                  <TableCell className="font-medium text-sm">{r.userEmail}</TableCell>
                  <TableCell className="text-right">{formatBytes(r.workspaceBytes)}</TableCell>
                  <TableCell className="text-right">{r.objectCount.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{r.skillCount}</TableCell>
                  <TableCell className="text-right">{r.memoryFileCount}</TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">
                    {r.lastActivityAt ? formatDate(r.lastActivityAt, true) : "never"}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.abandoned ? (
                      <Badge variant="destructive">Abandoned ({r.daysInactive}d)</Badge>
                    ) : r.daysInactive !== null ? (
                      <Badge variant="secondary">{r.daysInactive}d idle</Badge>
                    ) : (
                      <Badge variant="outline">New</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
