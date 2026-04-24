"use client"

import { useState, useEffect, useCallback } from "react"
import { useToast } from "@/components/ui/use-toast"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { IconRefresh, IconCheck, IconX } from "@tabler/icons-react"
import {
  getCredentialReads,
  getCredentialRequests,
  getCredentialAuditLog,
  resolveCredentialRequest,
  type CredentialReadRow,
  type CredentialRequestRow,
  type CredentialAuditRow,
} from "@/actions/admin/agent-credentials.actions"

export function CredentialsClient() {
  const { toast } = useToast()
  const [tab, setTab] = useState("requests")
  const [reads, setReads] = useState<CredentialReadRow[]>([])
  const [requests, setRequests] = useState<CredentialRequestRow[]>([])
  const [auditLog, setAuditLog] = useState<CredentialAuditRow[]>([])
  const [loading, setLoading] = useState(true)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [readsResult, requestsResult, auditResult] = await Promise.all([
        getCredentialReads(),
        getCredentialRequests("all"),
        getCredentialAuditLog(),
      ])

      if (readsResult.isSuccess && readsResult.data) setReads(readsResult.data)
      if (requestsResult.isSuccess && requestsResult.data) setRequests(requestsResult.data)
      if (auditResult.isSuccess && auditResult.data) setAuditLog(auditResult.data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const handleResolve = async (id: number, status: "fulfilled" | "rejected") => {
    const result = await resolveCredentialRequest(id, status)
    if (result.isSuccess) {
      toast({ title: `Request ${status}` })
      loadAll()
    } else {
      toast({
        title: "Error",
        description: result.message || "Failed to resolve",
        variant: "destructive",
      })
    }
  }

  const pendingCount = requests.filter((r) => r.status === "pending").length

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={loadAll} disabled={loading}>
          <IconRefresh className="h-4 w-4 mr-1" />
          Refresh
        </Button>
        {pendingCount > 0 && (
          <Badge variant="destructive">{pendingCount} pending request{pendingCount !== 1 ? "s" : ""}</Badge>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="requests">
            Requests {pendingCount > 0 && `(${pendingCount})`}
          </TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
        </TabsList>

        <TabsContent value="requests" className="mt-4">
          <RequestsTable requests={requests} loading={loading} onResolve={handleResolve} />
        </TabsContent>

        <TabsContent value="usage" className="mt-4">
          <ReadsTable reads={reads} loading={loading} />
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <AuditTable auditLog={auditLog} loading={loading} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function RequestsTable({
  requests, loading, onResolve,
}: {
  requests: CredentialRequestRow[]
  loading: boolean
  onResolve: (id: number, status: "fulfilled" | "rejected") => void
}) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Credential Name</TableHead>
            <TableHead>Requested By</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Skill Context</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="w-[160px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {requests.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground">
                {loading ? "Loading..." : "No credential requests"}
              </TableCell>
            </TableRow>
          ) : (
            requests.map((req) => (
              <TableRow key={req.id}>
                <TableCell className="font-medium">{req.credentialName}</TableCell>
                <TableCell>{req.requestedBy}</TableCell>
                <TableCell className="max-w-[200px] truncate">{req.reason}</TableCell>
                <TableCell>{req.skillContext || "—"}</TableCell>
                <TableCell>
                  <Badge
                    variant={
                      req.status === "pending"
                        ? "outline"
                        : req.status === "fulfilled"
                          ? "default"
                          : "destructive"
                    }
                  >
                    {req.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(req.createdAt).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  {req.status === "pending" && (
                    <div className="flex gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => onResolve(req.id, "fulfilled")}
                        title="Mark as fulfilled"
                      >
                        <IconCheck className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => onResolve(req.id, "rejected")}
                        title="Reject request"
                      >
                        <IconX className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function ReadsTable({ reads, loading }: { reads: CredentialReadRow[]; loading: boolean }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Credential Name</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Session</TableHead>
            <TableHead>Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reads.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                {loading ? "Loading..." : "No credential reads recorded"}
              </TableCell>
            </TableRow>
          ) : (
            reads.map((read) => (
              <TableRow key={read.id}>
                <TableCell className="font-medium">{read.credentialName}</TableCell>
                <TableCell>{read.userId}</TableCell>
                <TableCell className="text-sm text-muted-foreground truncate max-w-[200px]">
                  {read.sessionId || "—"}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(read.createdAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function AuditTable({ auditLog, loading }: { auditLog: CredentialAuditRow[]; loading: boolean }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Credential Name</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {auditLog.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                {loading ? "Loading..." : "No audit entries"}
              </TableCell>
            </TableRow>
          ) : (
            auditLog.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="font-medium">{entry.credentialName}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{entry.scope}</Badge>
                </TableCell>
                <TableCell>{entry.action}</TableCell>
                <TableCell>{entry.actorUserId ?? "system"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
