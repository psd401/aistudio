"use client"

import { Fragment, useCallback, useEffect, useMemo, useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { formatDate } from "@/lib/date-utils"
import {
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
  IconCopy,
  IconCheck,
} from "@tabler/icons-react"
import {
  acknowledgeFailures,
  generateTroubleshootingBundle,
  getAgentFailures,
  type FailureRange,
  type FailureRow,
} from "@/actions/admin/agent-failures.actions"

const RANGE_OPTIONS: { value: FailureRange; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
]

const SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "router", label: "Router" },
  { value: "harness", label: "Harness" },
  { value: "cron", label: "Cron" },
  { value: "agent_self_report", label: "Agent self-report" },
  { value: "tool", label: "Tool" },
  { value: "other", label: "Other" },
] as const

const SEVERITY_OPTIONS = [
  { value: "all", label: "All severities" },
  { value: "error", label: "Error" },
  { value: "warn", label: "Warn" },
  { value: "empty_response", label: "Empty response" },
] as const

const ACK_OPTIONS = [
  { value: "unack", label: "Unacknowledged" },
  { value: "ack", label: "Acknowledged" },
  { value: "all", label: "All" },
] as const

function severityBadge(sev: FailureRow["severity"]) {
  if (sev === "error")
    return (
      <Badge variant="destructive" className="text-xs">
        error
      </Badge>
    )
  if (sev === "warn")
    return (
      <Badge variant="default" className="text-xs">
        warn
      </Badge>
    )
  return (
    <Badge variant="secondary" className="text-xs">
      empty
    </Badge>
  )
}

function sourceBadge(src: FailureRow["source"]) {
  return (
    <Badge variant="outline" className="text-xs">
      {src}
    </Badge>
  )
}

function preview(text: string | null, max = 80): string {
  if (!text) return "-"
  const cleaned = text.replace(/\s+/g, " ").trim()
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…`
}

export function AgentFailuresClient() {
  const { toast } = useToast()
  const [range, setRange] = useState<FailureRange>("30d")
  const [source, setSource] = useState<string>("all")
  const [severity, setSeverity] = useState<string>("all")
  const [ackFilter, setAckFilter] = useState<string>("unack")
  const [rows, setRows] = useState<FailureRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<number[]>([])
  const [expanded, setExpanded] = useState<number[]>([])
  const [ackOpen, setAckOpen] = useState(false)
  const [ackNotes, setAckNotes] = useState("")
  const [bundleOpen, setBundleOpen] = useState(false)
  const [bundleMd, setBundleMd] = useState("")
  const [bundleCopied, setBundleCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getAgentFailures({
        range,
        source: source === "all" ? undefined : (source as FailureRow["source"]),
        severity:
          severity === "all" ? undefined : (severity as FailureRow["severity"]),
        acknowledged:
          ackFilter === "all" ? undefined : ackFilter === "ack",
        limit: 200,
      })
      if (result.isSuccess && result.data) {
        setRows(result.data.failures)
        setTotal(result.data.total)
        setSelected([])
      } else {
        toast({
          variant: "destructive",
          title: "Error loading failures",
          description: result.message,
        })
      }
    } catch {
      toast({
        variant: "destructive",
        title: "Error loading failures",
        description: "A network error occurred. Please try again.",
      })
    } finally {
      setLoading(false)
    }
  }, [range, source, severity, ackFilter, toast])

  useEffect(() => {
    void load()
  }, [load])

  const toggleSelect = (id: number) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const toggleAll = () => {
    setSelected((prev) =>
      prev.length === rows.length ? [] : rows.map((r) => r.id),
    )
  }

  const toggleExpand = (id: number) => {
    setExpanded((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const handleAcknowledge = async () => {
    if (selected.length === 0) return
    setBusy(true)
    try {
      const result = await acknowledgeFailures({
        ids: [...selected],
        notes: ackNotes || undefined,
      })
      if (result.isSuccess) {
        toast({ title: result.message ?? "Acknowledged" })
        setAckOpen(false)
        setAckNotes("")
        await load()
      } else {
        toast({
          variant: "destructive",
          title: "Acknowledge failed",
          description: result.message,
        })
      }
    } finally {
      setBusy(false)
    }
  }

  const handleGenerateBundle = async () => {
    if (selected.length === 0) return
    setBusy(true)
    try {
      const result = await generateTroubleshootingBundle([...selected])
      if (result.isSuccess && result.data) {
        setBundleMd(result.data.markdown)
        setBundleCopied(false)
        setBundleOpen(true)
      } else {
        toast({
          variant: "destructive",
          title: "Bundle failed",
          description: result.message,
        })
      }
    } finally {
      setBusy(false)
    }
  }

  const copyBundle = async () => {
    try {
      await navigator.clipboard.writeText(bundleMd)
      setBundleCopied(true)
      setTimeout(() => setBundleCopied(false), 2000)
      toast({ title: "Bundle copied to clipboard" })
    } catch {
      toast({
        variant: "destructive",
        title: "Copy failed",
        description: "Select the text and copy manually.",
      })
    }
  }

  const headerCheckboxState = useMemo<boolean | "indeterminate">(() => {
    if (rows.length === 0) return false
    if (selected.length === 0) return false
    if (selected.length === rows.length) return true
    return "indeterminate"
  }, [rows.length, selected.length])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Agent Failures</CardTitle>
            <CardDescription>
              Captured from router Lambda, harness adapter, cron, and agent
              self-reports. Acknowledge once triaged or bundle for handoff to
              Claude Code.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <IconRefresh className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-3">
          <Select value={range} onValueChange={(v) => setRange(v as FailureRange)}>
            <SelectTrigger className="w-[160px] h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger className="w-[180px] h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger className="w-[180px] h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEVERITY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={ackFilter} onValueChange={setAckFilter}>
            <SelectTrigger className="w-[180px] h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACK_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex-1" />
          <Button
            variant="default"
            size="sm"
            disabled={selected.length === 0 || busy}
            onClick={() => setAckOpen(true)}
          >
            Acknowledge ({selected.length})
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={selected.length === 0 || busy}
            onClick={handleGenerateBundle}
          >
            Generate bundle ({selected.length})
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-64 w-full" />
        ) : rows.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
            No failures match these filters.
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground mb-2">
              Showing {rows.length} of {total} failure{total === 1 ? "" : "s"}
              {total > rows.length ? " (limit 200, refine filters to see more)" : ""}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={headerCheckboxState}
                      onCheckedChange={toggleAll}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead className="w-8" />
                  <TableHead>When</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const isExpanded = expanded.includes(r.id)
                  return (
                    <Fragment key={r.id}>
                      <TableRow>
                        <TableCell>
                          <Checkbox
                            checked={selected.includes(r.id)}
                            onCheckedChange={() => toggleSelect(r.id)}
                            aria-label={`Select failure ${r.id}`}
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={() => toggleExpand(r.id)}
                            aria-label={isExpanded ? "Collapse" : "Expand"}
                          >
                            {isExpanded ? (
                              <IconChevronDown className="h-4 w-4" />
                            ) : (
                              <IconChevronRight className="h-4 w-4" />
                            )}
                          </Button>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDate(r.occurredAt, true)}
                        </TableCell>
                        <TableCell>{sourceBadge(r.source)}</TableCell>
                        <TableCell>{severityBadge(r.severity)}</TableCell>
                        <TableCell className="text-xs">
                          {r.userId ?? "-"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.model ?? "-"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.errorClass && (
                            <span className="font-mono text-[11px] mr-1">
                              {r.errorClass}
                            </span>
                          )}
                          <span className="text-muted-foreground">
                            {preview(r.errorMessage, 90)}
                          </span>
                        </TableCell>
                        <TableCell>
                          {r.acknowledged ? (
                            <Badge variant="outline" className="text-xs">
                              ack
                            </Badge>
                          ) : (
                            <Badge variant="default" className="text-xs">
                              new
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow>
                          <TableCell />
                          <TableCell colSpan={8} className="bg-muted/30">
                            <FailureDetail row={r} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>

      <Dialog open={ackOpen} onOpenChange={(open) => { setAckOpen(open); if (!open) setAckNotes("") }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Acknowledge {selected.length} failure(s)</DialogTitle>
            <DialogDescription>
              Optional note about how this was handled (visible in audit log).
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={ackNotes}
            onChange={(e) => setAckNotes(e.target.value)}
            placeholder="e.g. Caused by missing Google credential — fixed in PR #1234"
            rows={4}
            maxLength={4000}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAckOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={handleAcknowledge} disabled={busy}>
              Acknowledge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bundleOpen} onOpenChange={setBundleOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Troubleshooting bundle</DialogTitle>
            <DialogDescription>
              Copy this markdown and paste into Claude Code to get root-cause
              analysis and proposed fixes.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={bundleMd}
            readOnly
            rows={20}
            className="font-mono text-xs"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBundleOpen(false)}>
              Close
            </Button>
            <Button onClick={copyBundle}>
              {bundleCopied ? (
                <>
                  <IconCheck className="h-4 w-4 mr-2" />
                  Copied
                </>
              ) : (
                <>
                  <IconCopy className="h-4 w-4 mr-2" />
                  Copy to clipboard
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function FailureDetail({ row }: { row: FailureRow }) {
  return (
    <div className="text-xs space-y-2 py-2">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <div>
          <span className="text-muted-foreground">Session:</span>{" "}
          <span className="font-mono">{row.sessionId ?? "-"}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Schedule:</span>{" "}
          {row.scheduleName ?? "-"}
        </div>
        <div>
          <span className="text-muted-foreground">Acknowledged by:</span>{" "}
          {row.acknowledgedBy ?? "-"}
          {row.acknowledgedAt && ` · ${formatDate(row.acknowledgedAt, true)}`}
        </div>
        <div>
          <span className="text-muted-foreground">Notes:</span>{" "}
          {row.notes ?? "-"}
        </div>
      </div>
      {row.errorMessage && (
        <div>
          <div className="text-muted-foreground mb-1">Error message</div>
          <pre className="bg-background border rounded p-2 whitespace-pre-wrap font-mono text-[11px] max-h-40 overflow-auto">
            {row.errorMessage}
          </pre>
        </div>
      )}
      {row.context && (
        <div>
          <div className="text-muted-foreground mb-1">Context</div>
          <pre className="bg-background border rounded p-2 font-mono text-[11px] max-h-40 overflow-auto">
            {JSON.stringify(row.context, null, 2)}
          </pre>
        </div>
      )}
      {row.stackExcerpt && (
        <div>
          <div className="text-muted-foreground mb-1">Stack</div>
          <pre className="bg-background border rounded p-2 font-mono text-[11px] max-h-40 overflow-auto">
            {row.stackExcerpt}
          </pre>
        </div>
      )}
    </div>
  )
}
