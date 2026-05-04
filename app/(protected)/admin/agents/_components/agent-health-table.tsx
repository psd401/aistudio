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
    const lastScan = data?.lastScan
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent Health</CardTitle>
        </CardHeader>
        <CardContent>
          {lastScan && (
            <div className="text-xs text-muted-foreground mb-3 border rounded p-2 bg-muted/30">
              <span className="font-medium">Last scan:</span>{" "}
              {formatDate(lastScan.runAt, true)} · snapshot{" "}
              {lastScan.snapshotDate} · {lastScan.usersTotal} users ·{" "}
              {lastScan.abandoned} abandoned
              {lastScan.error && (
                <span className="text-destructive">
                  {" "}
                  · error: {lastScan.error}
                </span>
              )}
            </div>
          )}
          <div className="h-40 flex flex-col items-center justify-center gap-2 text-sm">
            <div className="text-muted-foreground">
              {lastScan
                ? "Scanner ran but produced 0 snapshots. Check users table & S3 workspace prefixes."
                : "Daily health Lambda has not run yet."}
            </div>
            <div className="text-xs text-muted-foreground max-w-md text-center">
              Expected schedule: once per day. If{" "}
              <code className="text-[11px]">agent_health_scan_runs</code> stays
              empty for &gt;48h, the Lambda is failing silently — check
              CloudWatch logs for the{" "}
              <code className="text-[11px]">agent-health-daily</code> function.
            </div>
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
          {data.lastScan && (
            <p className="text-xs text-muted-foreground mt-1">
              Last scan: {formatDate(data.lastScan.runAt, true)} ·{" "}
              {data.lastScan.usersTotal} users ·{" "}
              {data.lastScan.abandoned} abandoned
            </p>
          )}
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
