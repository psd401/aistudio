"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useToast } from "@/components/ui/use-toast"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import {
  getAgentWorkspaceTokens,
  type WorkspaceTokenListResult,
} from "@/actions/admin/agent-workspace.actions"
import type { WorkspaceTokenStatus } from "@/lib/db/schema/tables/agent-workspace-tokens"

function StatusBadge({ status }: { status: WorkspaceTokenStatus }) {
  const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    active: "default",
    pending: "secondary",
    stale: "destructive",
    revoked: "outline",
  }
  return (
    <Badge variant={variants[status] ?? "secondary"}>
      {status === "active" ? "Connected" : status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  )
}

function KindBadge({ kind }: { kind: "agent_account" | "user_account" }) {
  return kind === "user_account" ? (
    <Badge variant="outline" className="text-xs">User mailbox</Badge>
  ) : (
    <Badge variant="outline" className="text-xs">Agent account</Badge>
  )
}

function formatDate(iso: string | null): string {
  if (!iso) return "-"
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
  })
}

function StatusCards({ counts }: { counts: WorkspaceTokenListResult["statusCounts"] }) {
  const items = [
    { label: "Connected", value: counts.active, color: "text-green-600" },
    { label: "Pending", value: counts.pending, color: "text-yellow-600" },
    { label: "Stale", value: counts.stale, color: "text-red-600" },
    { label: "Revoked", value: counts.revoked, color: "text-gray-600" },
    { label: "Not Connected", value: counts.notConnected, color: "text-gray-400" },
  ]
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      {items.map((item) => (
        <Card key={item.label}>
          <CardHeader className="pb-2">
            <CardDescription>{item.label}</CardDescription>
            <CardTitle className={`text-2xl ${item.color}`}>{item.value}</CardTitle>
          </CardHeader>
        </Card>
      ))}
    </div>
  )
}

export function AgentWorkspaceTable() {
  const { toast } = useToast()
  const [data, setData] = useState<WorkspaceTokenListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const loadedRef = useRef(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getAgentWorkspaceTokens()
      if (result.isSuccess && result.data) {
        setData(result.data)
      } else {
        toast({ variant: "destructive", title: "Error loading workspace tokens", description: result.message })
      }
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    loadData()
  }, [loadData])

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-muted-foreground">Loading workspace connection status...</CardContent>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-muted-foreground">No data available.</CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <StatusCards counts={data.statusCounts} />
      <Card>
        <CardHeader>
          <CardTitle>Workspace Connections</CardTitle>
          <CardDescription>Google Workspace OAuth token status per user</CardDescription>
        </CardHeader>
        <CardContent>
          {data.tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No workspace connections yet. Connections are created when users authorize their agent accounts.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Connection</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Last Verified</TableHead>
                  <TableHead>Connected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.tokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{token.ownerName ?? token.ownerEmail}</p>
                        {token.ownerName && <p className="text-xs text-muted-foreground">{token.ownerEmail}</p>}
                      </div>
                    </TableCell>
                    <TableCell><KindBadge kind={token.tokenKind} /></TableCell>
                    <TableCell className="text-sm font-mono">
                      {token.tokenKind === "user_account" ? token.ownerEmail : token.agentEmail}
                    </TableCell>
                    <TableCell><StatusBadge status={token.status} /></TableCell>
                    <TableCell className="text-sm">{token.grantedScopes.length} scope{token.grantedScopes.length !== 1 ? "s" : ""}</TableCell>
                    <TableCell className="text-sm">{formatDate(token.lastVerifiedAt)}</TableCell>
                    <TableCell className="text-sm">{formatDate(token.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
