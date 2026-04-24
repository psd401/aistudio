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

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    active: "default",
    pending: "secondary",
    stale: "destructive",
    revoked: "outline",
  }

  const labels: Record<string, string> = {
    active: "Connected",
    pending: "Pending",
    stale: "Stale",
    revoked: "Revoked",
  }

  return (
    <Badge variant={variants[status] ?? "secondary"}>
      {labels[status] ?? status}
    </Badge>
  )
}

function formatDate(iso: string | null): string {
  if (!iso) return "-"
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
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
        toast({
          variant: "destructive",
          title: "Error loading workspace tokens",
          description: result.message,
        })
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
        <CardContent className="pt-6 text-center text-muted-foreground">
          Loading workspace connection status...
        </CardContent>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-muted-foreground">
          No data available.
        </CardContent>
      </Card>
    )
  }

  const { tokens, statusCounts } = data

  return (
    <div className="space-y-4">
      {/* Status summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Connected</CardDescription>
            <CardTitle className="text-2xl text-green-600">
              {statusCounts.active}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Pending</CardDescription>
            <CardTitle className="text-2xl text-yellow-600">
              {statusCounts.pending}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Stale</CardDescription>
            <CardTitle className="text-2xl text-red-600">
              {statusCounts.stale}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Revoked</CardDescription>
            <CardTitle className="text-2xl text-gray-600">
              {statusCounts.revoked}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Not Connected</CardDescription>
            <CardTitle className="text-2xl text-gray-400">
              {statusCounts.notConnected}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Token table */}
      <Card>
        <CardHeader>
          <CardTitle>Workspace Connections</CardTitle>
          <CardDescription>
            Google Workspace OAuth token status per user
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No workspace connections yet. Connections are created when users
              authorize their agent accounts.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Agent Account</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Last Verified</TableHead>
                  <TableHead>Connected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">
                          {token.ownerName ?? token.ownerEmail}
                        </p>
                        {token.ownerName && (
                          <p className="text-xs text-muted-foreground">
                            {token.ownerEmail}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm font-mono">
                      {token.agentEmail}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={token.status} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {token.grantedScopes.length} scope
                      {token.grantedScopes.length !== 1 ? "s" : ""}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(token.lastVerifiedAt)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(token.createdAt)}
                    </TableCell>
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
