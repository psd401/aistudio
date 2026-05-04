"use client"

import { useState, useEffect, useCallback } from "react"
import { useToast } from "@/components/ui/use-toast"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { IconRefresh, IconCheck, IconX, IconLock, IconPlus } from "@tabler/icons-react"
import {
  getCredentialReads,
  getCredentialRequests,
  getCredentialAuditLog,
  resolveCredentialRequest,
  provisionSharedSecret,
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
          <TabsTrigger value="provision">Provision</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
        </TabsList>

        <TabsContent value="requests" className="mt-4">
          <RequestsTable requests={requests} loading={loading} onResolve={handleResolve} />
        </TabsContent>

        <TabsContent value="provision" className="mt-4">
          <ProvisionForm onSuccess={loadAll} />
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

function ProvisionForm({ onSuccess }: { onSuccess: () => void }) {
  const { toast } = useToast()
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !value.trim()) return
    setConfirmOpen(true)
  }

  const handleConfirmedProvision = async () => {
    setSubmitting(true)
    try {
      const result = await provisionSharedSecret(name.trim(), value)
      if (result.isSuccess) {
        toast({
          title: result.data.action === "created" ? "Secret Created" : "Secret Rotated",
          description: result.message,
        })
        setName("")
        setValue("")
        onSuccess()
      } else {
        toast({
          title: "Error",
          description: result.message || "Failed to provision secret",
          variant: "destructive",
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IconLock className="h-5 w-5" />
          Provision Shared Secret
        </CardTitle>
        <CardDescription>
          Create or rotate a district-wide shared secret at{" "}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">
            psd-agent-creds/&#123;env&#125;/shared/&#123;name&#125;
          </code>
          . The secret value is written to AWS Secrets Manager and an audit entry is recorded.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="secret-name">Credential Name</Label>
            <Input
              id="secret-name"
              placeholder="e.g. openai-api-key"
              value={name}
              onChange={(e) => setName(e.target.value)}
              pattern="^[a-z][\da-z_-]{0,127}$"
              autoComplete="off"
              required
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, numbers, hyphens, underscores. Must start with a letter.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="secret-value">Secret Value</Label>
            <Textarea
              id="secret-value"
              placeholder="Paste the secret value here..."
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
              disabled={submitting}
              rows={3}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              If the secret already exists, it will be rotated (overwritten). Never logged or displayed again.
            </p>
          </div>

          <Button type="submit" disabled={submitting || !name.trim() || !value.trim()}>
            <IconPlus className="h-4 w-4 mr-1" />
            {submitting ? "Provisioning..." : "Provision Secret"}
          </Button>
        </form>

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm Secret Provisioning</AlertDialogTitle>
              <AlertDialogDescription>
                This will create or overwrite the secret at{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">
                  psd-agent-creds/&#123;env&#125;/shared/{name}
                </code>
                . If the secret already exists, the current value will be permanently replaced. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleConfirmedProvision}>
                Confirm Provision
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
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
            <TableHead>Ticket</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="w-[160px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {requests.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground">
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
                  {req.freshserviceTicketId ? (
                    <Badge variant="outline" className="font-mono text-xs">
                      {req.freshserviceTicketId}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </TableCell>
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
