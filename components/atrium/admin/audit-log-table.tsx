"use client"

/**
 * Content audit trail viewer (Epic #1059 completion) — read-only, paginated
 * window over `content_audit_logs` for the Audit tab of /admin/atrium.
 * Filters: action / surface / outcome (exact) + free-text object id; newest
 * first, 50 rows per page (page size decided server-side).
 */

import { useState, useTransition } from "react"
import {
  listContentAuditAction,
  type ContentAuditPage,
  type ContentAuditRowDTO,
} from "@/actions/db/atrium/audit-log"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

// Known values of the varchar filter columns (see lib/content/audit.ts). "all"
// is the unfiltered sentinel — Radix Select forbids an empty item value.
const ACTIONS = [
  "create",
  "update",
  "create_version",
  "set_visibility",
  "publish",
  "unpublish",
  "export_okf",
  "import_okf",
] as const
const SURFACES = ["mcp", "rest"] as const
const OUTCOMES = ["ok", "error", "approval_required"] as const

function formatTime(iso: string | null): string {
  if (!iso) return "—"
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString()
}

function actorOf(row: ContentAuditRowDTO): string {
  if (row.actorKind === "agent") {
    return row.agentLabel ? `Agent: ${row.agentLabel}` : "Agent"
  }
  return row.actorUserId != null ? `User #${row.actorUserId}` : "Human"
}

function outcomeVariant(
  outcome: string
): "default" | "destructive" | "outline" | "secondary" {
  if (outcome === "error") return "destructive"
  if (outcome === "approval_required") return "secondary"
  return "outline"
}

interface AuditLogTableProps {
  initialData: ContentAuditPage
  initialError: string | null
}

interface AuditFiltersProps {
  action: string
  surface: string
  outcome: string
  objectId: string
  isPending: boolean
  onActionChange: (value: string) => void
  onSurfaceChange: (value: string) => void
  onOutcomeChange: (value: string) => void
  onObjectIdChange: (value: string) => void
  onApply: () => void
}

/** The filter controls row (selects + object-id input + Apply). */
function AuditFilters({
  action,
  surface,
  outcome,
  objectId,
  isPending,
  onActionChange,
  onSurfaceChange,
  onOutcomeChange,
  onObjectIdChange,
  onApply,
}: AuditFiltersProps) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Select value={action} onValueChange={onActionChange}>
        <SelectTrigger className="w-[170px]" aria-label="Filter by action">
          <SelectValue placeholder="Action" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All actions</SelectItem>
          {ACTIONS.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={surface} onValueChange={onSurfaceChange}>
        <SelectTrigger className="w-[130px]" aria-label="Filter by surface">
          <SelectValue placeholder="Surface" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All surfaces</SelectItem>
          {SURFACES.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={outcome} onValueChange={onOutcomeChange}>
        <SelectTrigger className="w-[180px]" aria-label="Filter by outcome">
          <SelectValue placeholder="Outcome" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All outcomes</SelectItem>
          {OUTCOMES.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        className="w-[280px]"
        value={objectId}
        onChange={(e) => onObjectIdChange(e.target.value)}
        placeholder="Object id (full or fragment)"
        aria-label="Filter by object id"
      />

      <Button size="sm" onClick={onApply} disabled={isPending}>
        Apply filters
      </Button>
    </div>
  )
}

export function AuditLogTable({ initialData, initialError }: AuditLogTableProps) {
  const [data, setData] = useState(initialData)
  const [error, setError] = useState(initialError)
  const [action, setAction] = useState("all")
  const [surface, setSurface] = useState("all")
  const [outcome, setOutcome] = useState("all")
  const [objectId, setObjectId] = useState("")
  const [isPending, startTransition] = useTransition()

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize))

  function load(page: number) {
    startTransition(async () => {
      const result = await listContentAuditAction({
        action: action === "all" ? undefined : action,
        surface: surface === "all" ? undefined : surface,
        outcome: outcome === "all" ? undefined : outcome,
        objectId: objectId.trim() || undefined,
        page,
      })
      if (result.isSuccess) {
        setData(result.data)
        setError(null)
      } else {
        setError(result.message ?? "Failed to load the audit log")
      }
    })
  }

  return (
    <div className="space-y-4">
      <AuditFilters
        action={action}
        surface={surface}
        outcome={outcome}
        objectId={objectId}
        isPending={isPending}
        onActionChange={setAction}
        onSurfaceChange={setSurface}
        onOutcomeChange={setOutcome}
        onObjectIdChange={setObjectId}
        onApply={() => load(1)}
      />

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No audit entries match the current filters.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Surface</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Object</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap">
                  {formatTime(row.createdAt)}
                </TableCell>
                <TableCell>{row.action}</TableCell>
                <TableCell>{row.surface}</TableCell>
                <TableCell>{actorOf(row)}</TableCell>
                <TableCell>
                  <span className="font-mono text-xs">
                    {row.objectId ?? "—"}
                  </span>
                </TableCell>
                <TableCell>{row.destination ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={outcomeVariant(row.outcome)}>
                    {row.outcome}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-[240px] truncate" title={row.error ?? undefined}>
                  {row.error ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Page {data.page} of {totalPages} ({data.total} entries)
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isPending || data.page <= 1}
            onClick={() => load(data.page - 1)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={isPending || data.page >= totalPages}
            onClick={() => load(data.page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}
