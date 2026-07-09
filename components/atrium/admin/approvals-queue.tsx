"use client"

/**
 * §26.4 approvals queue (Epic #1059 completion) — the pending
 * `content_publish_requests` rows with Approve / Deny controls.
 *
 * Approve replays the recorded action as the approving admin (except `export`,
 * which is decision-only — the exporter must re-run; the row notes this). Deny
 * requires a note. A replay failure keeps the row pending and shows the error.
 */

import { useState, useTransition } from "react"
import {
  approvePublishRequestAction,
  denyPublishRequestAction,
  listPendingApprovalsAction,
  type PendingApprovalDTO,
} from "@/actions/db/atrium/approvals"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const KIND_LABELS: Record<PendingApprovalDTO["requestKind"], string> = {
  publish: "Publish",
  visibility_widen: "Visibility widen",
  unpublish: "Unpublish",
  export: "Export",
}

/**
 * Whether approving a `publish` request will ALSO widen the object's visibility
 * to public (the caller bundled a widen — issue #1118 item 5). Surfaced in the
 * queue so the admin sees that approving changes visibility, not just publishes.
 */
function widensVisibility(request: PendingApprovalDTO): boolean {
  return (
    request.requestKind === "publish" &&
    request.context.visibility?.level === "public"
  )
}

function formatTime(iso: string | null): string {
  if (!iso) return "—"
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString()
}

function requesterOf(request: PendingApprovalDTO): string {
  if (request.requesterLabel && request.requesterEmail) {
    return `${request.requesterLabel} (for ${request.requesterEmail})`
  }
  return (
    request.requesterLabel ??
    request.requesterEmail ??
    (request.requestedByUserId != null
      ? `User #${request.requestedByUserId}`
      : "Unknown")
  )
}

function objectOf(request: PendingApprovalDTO): string {
  if (request.objectTitle) return request.objectTitle
  if (request.requestKind === "export") {
    return request.context.collectionId
      ? `Collection ${request.context.collectionId}`
      : "Collection export"
  }
  return request.objectId ?? "—"
}

interface ApprovalsQueueProps {
  initialRequests: PendingApprovalDTO[]
  initialError: string | null
}

interface DecisionCellProps {
  busy: boolean
  denying: boolean
  denyNote: string
  onDenyNoteChange: (note: string) => void
  onApprove: () => void
  onStartDeny: () => void
  onCancelDeny: () => void
  onConfirmDeny: () => void
}

/** The Approve / Deny controls for one queue row (Deny expands a note editor). */
function DecisionCell({
  busy,
  denying,
  denyNote,
  onDenyNoteChange,
  onApprove,
  onStartDeny,
  onCancelDeny,
  onConfirmDeny,
}: DecisionCellProps) {
  if (denying) {
    return (
      <div className="space-y-2 max-w-[280px] ml-auto">
        <Textarea
          value={denyNote}
          onChange={(e) => onDenyNoteChange(e.target.value)}
          placeholder="Reason for denial (required)"
          rows={2}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancelDeny}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy || !denyNote.trim()}
            onClick={onConfirmDeny}
          >
            Confirm deny
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" disabled={busy} onClick={onApprove}>
        Approve
      </Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={onStartDeny}>
        Deny
      </Button>
    </div>
  )
}

/** Object / kind / requester / time cells for one queue row. */
function RequestCells({ request }: { request: PendingApprovalDTO }) {
  return (
    <>
      <TableCell>
        <div className="font-medium">{objectOf(request)}</div>
        {request.objectSlug ? (
          <div className="text-xs text-muted-foreground font-mono">
            {request.objectSlug}
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge variant="outline">{KIND_LABELS[request.requestKind]}</Badge>
        {widensVisibility(request) ? (
          <Badge variant="secondary" className="ml-1">
            + widen to public
          </Badge>
        ) : null}
        {request.requestKind === "export" ? (
          <div className="text-xs text-muted-foreground mt-1 max-w-[200px]">
            Approval is recorded only — the exporter must re-run the export.
          </div>
        ) : null}
      </TableCell>
      <TableCell>{request.destination}</TableCell>
      <TableCell>{requesterOf(request)}</TableCell>
      <TableCell>{formatTime(request.createdAt)}</TableCell>
    </>
  )
}

export function ApprovalsQueue({
  initialRequests,
  initialError,
}: ApprovalsQueueProps) {
  const [requests, setRequests] = useState(initialRequests)
  const [error, setError] = useState(initialError)
  const [notice, setNotice] = useState<string | null>(null)
  // The row whose Deny note editor is open, and its draft note.
  const [denyingId, setDenyingId] = useState<string | null>(null)
  const [denyNote, setDenyNote] = useState("")
  const [busyId, setBusyId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function refresh() {
    startTransition(async () => {
      const result = await listPendingApprovalsAction()
      if (result.isSuccess) {
        setRequests(result.data ?? [])
        setError(null)
      } else {
        setError(result.message ?? "Failed to refresh pending approvals")
      }
    })
  }

  function approve(request: PendingApprovalDTO) {
    setBusyId(request.id)
    setNotice(null)
    setError(null)
    startTransition(async () => {
      const result = await approvePublishRequestAction(request.id)
      setBusyId(null)
      if (result.isSuccess) {
        setRequests((prev) => prev.filter((r) => r.id !== request.id))
        setNotice(result.message ?? "Request approved")
      } else {
        // Replay failures leave the row pending server-side; keep it visible.
        setError(result.message ?? "Failed to approve the request")
      }
    })
  }

  function deny(request: PendingApprovalDTO) {
    setBusyId(request.id)
    setNotice(null)
    setError(null)
    startTransition(async () => {
      const result = await denyPublishRequestAction(request.id, denyNote)
      setBusyId(null)
      if (result.isSuccess) {
        setRequests((prev) => prev.filter((r) => r.id !== request.id))
        setNotice(result.message ?? "Request denied")
        setDenyingId(null)
        setDenyNote("")
      } else {
        setError(result.message ?? "Failed to deny the request")
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Blocked public-exposure requests awaiting an administrator decision.
          Approving replays the requested action as you.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={isPending}
        >
          Refresh
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}

      {requests.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No pending requests.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Object</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Requested by</TableHead>
              <TableHead>Requested</TableHead>
              <TableHead className="text-right">Decision</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((request) => (
              <TableRow key={request.id}>
                <RequestCells request={request} />
                <TableCell className="text-right">
                  <DecisionCell
                    busy={busyId === request.id}
                    denying={denyingId === request.id}
                    denyNote={denyNote}
                    onDenyNoteChange={setDenyNote}
                    onApprove={() => approve(request)}
                    onStartDeny={() => {
                      setDenyingId(request.id)
                      setDenyNote("")
                    }}
                    onCancelDeny={() => {
                      setDenyingId(null)
                      setDenyNote("")
                    }}
                    onConfirmDeny={() => deny(request)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
