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

type Toast = ReturnType<typeof useToast>["toast"]

function useFailureRows(toast: Toast) {
  const [range, setRange] = useState<FailureRange>("30d")
  const [source, setSource] = useState<string>("all")
  const [severity, setSeverity] = useState<string>("all")
  const [ackFilter, setAckFilter] = useState<string>("unack")
  const [rows, setRows] = useState<FailureRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

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
      if (!result.isSuccess || !result.data) {
        toast({
          variant: "destructive",
          title: "Error loading failures",
          description: result.message,
        })
        return
      }
      setRows(result.data.failures)
      setTotal(result.data.total)
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
  return {
    ackFilter,
    load,
    loading,
    range,
    rows,
    setAckFilter,
    setRange,
    setSeverity,
    setSource,
    severity,
    source,
    total,
  }
}

function FailureToolbar({
  ackFilter,
  busy,
  loading,
  range,
  selectedCount,
  severity,
  source,
  onAcknowledge,
  onBundle,
  onLoad,
  onAckFilterChange,
  onRangeChange,
  onSeverityChange,
  onSourceChange,
}: {
  ackFilter: string
  busy: boolean
  loading: boolean
  range: FailureRange
  selectedCount: number
  severity: string
  source: string
  onAcknowledge: () => void
  onBundle: () => void
  onLoad: () => void
  onAckFilterChange: (value: string) => void
  onRangeChange: (value: FailureRange) => void
  onSeverityChange: (value: string) => void
  onSourceChange: (value: string) => void
}) {
  return (
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
        <Button
          variant="outline"
          size="sm"
          onClick={onLoad}
          disabled={loading}
        >
          <IconRefresh className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-3">
        <Select
          value={range}
          onValueChange={value => onRangeChange(value as FailureRange)}
        >
          <SelectTrigger className="w-[160px] h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map(option => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {[
          {
            value: source,
            onChange: onSourceChange,
            options: SOURCE_OPTIONS,
            width: "w-[180px]",
          },
          {
            value: severity,
            onChange: onSeverityChange,
            options: SEVERITY_OPTIONS,
            width: "w-[180px]",
          },
          {
            value: ackFilter,
            onChange: onAckFilterChange,
            options: ACK_OPTIONS,
            width: "w-[180px]",
          },
        ].map((filter, index) => (
          <Select
            key={index}
            value={filter.value}
            onValueChange={filter.onChange}
          >
            <SelectTrigger className={`${filter.width} h-8 text-sm`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {filter.options.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
        <div className="flex-1" />
        <Button
          size="sm"
          disabled={selectedCount === 0 || busy}
          onClick={onAcknowledge}
        >
          Acknowledge ({selectedCount})
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={selectedCount === 0 || busy}
          onClick={onBundle}
        >
          Generate bundle ({selectedCount})
        </Button>
      </div>
    </CardHeader>
  )
}

function FailureTableContent({
  expanded,
  headerCheckboxState,
  loading,
  rows,
  selected,
  total,
  onToggleAll,
  onToggleExpand,
  onToggleSelect,
}: {
  expanded: number[]
  headerCheckboxState: boolean | "indeterminate"
  loading: boolean
  rows: FailureRow[]
  selected: number[]
  total: number
  onToggleAll: () => void
  onToggleExpand: (id: number) => void
  onToggleSelect: (id: number) => void
}) {
  if (loading) {
    return (
      <CardContent>
        <Skeleton className="h-64 w-full" />
      </CardContent>
    )
  }
  if (rows.length === 0) {
    return (
      <CardContent>
        <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
          No failures match these filters.
        </div>
      </CardContent>
    )
  }
  return (
    <CardContent>
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
                onCheckedChange={onToggleAll}
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
          {rows.map(row => {
            const isExpanded = expanded.includes(row.id)
            return (
              <Fragment key={row.id}>
                <TableRow>
                  <TableCell>
                    <Checkbox
                      checked={selected.includes(row.id)}
                      onCheckedChange={() => onToggleSelect(row.id)}
                      aria-label={`Select failure ${row.id}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => onToggleExpand(row.id)}
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
                    {formatDate(row.occurredAt, true)}
                  </TableCell>
                  <TableCell>{sourceBadge(row.source)}</TableCell>
                  <TableCell>{severityBadge(row.severity)}</TableCell>
                  <TableCell className="text-xs">
                    {row.userId ?? "-"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.model ?? "-"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.errorClass && (
                      <span className="font-mono text-[11px] mr-1">
                        {row.errorClass}
                      </span>
                    )}
                    <span className="text-muted-foreground">
                      {preview(row.errorMessage, 90)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={row.acknowledged ? "outline" : "default"}
                      className="text-xs"
                    >
                      {row.acknowledged ? "ack" : "new"}
                    </Badge>
                  </TableCell>
                </TableRow>
                {isExpanded && (
                  <TableRow>
                    <TableCell />
                    <TableCell colSpan={8} className="bg-muted/30">
                      <FailureDetail row={row} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
    </CardContent>
  )
}

function FailureDialogs({
  ackNotes,
  ackOpen,
  bundleCopied,
  bundleMd,
  bundleOpen,
  busy,
  selectedCount,
  onAckNotesChange,
  onAckOpenChange,
  onAcknowledge,
  onBundleOpenChange,
  onCopy,
}: {
  ackNotes: string
  ackOpen: boolean
  bundleCopied: boolean
  bundleMd: string
  bundleOpen: boolean
  busy: boolean
  selectedCount: number
  onAckNotesChange: (value: string) => void
  onAckOpenChange: (open: boolean) => void
  onAcknowledge: () => void
  onBundleOpenChange: (open: boolean) => void
  onCopy: () => void
}) {
  return (
    <>
      <Dialog open={ackOpen} onOpenChange={onAckOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Acknowledge {selectedCount} failure(s)</DialogTitle>
            <DialogDescription>
              Optional note about how this was handled (visible in audit log).
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={ackNotes}
            onChange={event => onAckNotesChange(event.target.value)}
            placeholder="e.g. Caused by missing Google credential — fixed in PR #1234"
            rows={4}
            maxLength={4000}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onAckOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={onAcknowledge} disabled={busy}>
              Acknowledge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={bundleOpen} onOpenChange={onBundleOpenChange}>
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
            <Button
              variant="outline"
              onClick={() => onBundleOpenChange(false)}
            >
              Close
            </Button>
            <Button onClick={onCopy}>
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
    </>
  )
}

export function AgentFailuresClient() {
  const { toast } = useToast()
  const failureRows = useFailureRows(toast)
  const [selected, setSelected] = useState<number[]>([])
  const [expanded, setExpanded] = useState<number[]>([])
  const [ackOpen, setAckOpen] = useState(false)
  const [ackNotes, setAckNotes] = useState("")
  const [bundleOpen, setBundleOpen] = useState(false)
  const [bundleMd, setBundleMd] = useState("")
  const [bundleCopied, setBundleCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSelected([])
  }, [
    failureRows.ackFilter,
    failureRows.range,
    failureRows.severity,
    failureRows.source,
  ])

  const toggleSelect = (id: number) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const toggleAll = () => {
    setSelected((prev) =>
      prev.length === failureRows.rows.length
        ? []
        : failureRows.rows.map(row => row.id),
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
        await failureRows.load()
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
    if (failureRows.rows.length === 0) return false
    if (selected.length === 0) return false
    if (selected.length === failureRows.rows.length) return true
    return "indeterminate"
  }, [failureRows.rows.length, selected.length])

  return (
    <Card>
      <FailureToolbar
        ackFilter={failureRows.ackFilter}
        busy={busy}
        loading={failureRows.loading}
        range={failureRows.range}
        selectedCount={selected.length}
        severity={failureRows.severity}
        source={failureRows.source}
        onAcknowledge={() => setAckOpen(true)}
        onBundle={() => void handleGenerateBundle()}
        onLoad={() => void failureRows.load()}
        onAckFilterChange={failureRows.setAckFilter}
        onRangeChange={failureRows.setRange}
        onSeverityChange={failureRows.setSeverity}
        onSourceChange={failureRows.setSource}
      />
      <FailureTableContent
        expanded={expanded}
        headerCheckboxState={headerCheckboxState}
        loading={failureRows.loading}
        rows={failureRows.rows}
        selected={selected}
        total={failureRows.total}
        onToggleAll={toggleAll}
        onToggleExpand={toggleExpand}
        onToggleSelect={toggleSelect}
      />
      <FailureDialogs
        ackNotes={ackNotes}
        ackOpen={ackOpen}
        bundleCopied={bundleCopied}
        bundleMd={bundleMd}
        bundleOpen={bundleOpen}
        busy={busy}
        selectedCount={selected.length}
        onAckNotesChange={setAckNotes}
        onAckOpenChange={open => {
          setAckOpen(open)
          if (!open) setAckNotes("")
        }}
        onAcknowledge={() => void handleAcknowledge()}
        onBundleOpenChange={setBundleOpen}
        onCopy={() => void copyBundle()}
      />
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
