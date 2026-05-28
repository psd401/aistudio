"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { TriageSummaryRow } from "@/actions/admin/agent-triage.actions"
import { formatDate } from "@/lib/date-utils"

interface Props {
  data: TriageSummaryRow[]
  loading?: boolean
}

export function AgentTriageTable({ data, loading = false }: Props) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Email Triage</CardTitle>
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
        <CardTitle className="text-base">Email Triage</CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Per-user opt-in state for the @psd/Important / @psd/Later / @psd/News
          / @psd/Task workflow. Click Manage to see decisions, rules, and admin
          actions for a single user.
        </p>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="h-32 flex flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
            <div>No users have opted in to email triage yet.</div>
            <div className="text-xs">
              Users opt in by asking their agent in Chat: &quot;start triaging
              my email.&quot;
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Rules</TableHead>
                <TableHead className="text-right">Escalations</TableHead>
                <TableHead className="text-right">Recent decisions</TableHead>
                <TableHead className="text-right">Learned</TableHead>
                <TableHead>Last decision</TableHead>
                <TableHead>Last poll</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow key={r.userEmail}>
                  <TableCell className="font-mono text-xs">
                    {r.userEmail}
                  </TableCell>
                  <TableCell>
                    {r.enabled ? (
                      <Badge variant="default">enabled</Badge>
                    ) : (
                      <Badge variant="secondary">paused</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{r.ruleCount}</TableCell>
                  <TableCell className="text-right">
                    {r.escalationCount}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.recentDecisionsCount}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {r.learnedPatternsCount}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.lastDecision ? (
                      <span title={r.lastDecision.subject}>
                        <Badge
                          variant="outline"
                          className="mr-1 text-[10px] py-0"
                        >
                          {r.lastDecision.label}
                        </Badge>
                        {formatDate(r.lastDecision.ts, true)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.lastPollAt ? formatDate(r.lastPollAt, true) : "—"}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/agents/${encodeURIComponent(r.userEmail)}/triage`}
                    >
                      <Button variant="outline" size="sm">
                        Manage
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
