"use client"

import { useState, useEffect, useCallback } from "react"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { PageBranding } from "@/components/ui/page-branding"
import { IconRefresh, IconCheck, IconX } from "@tabler/icons-react"
import {
  getSkillReviewQueue,
  approveSkillToShared,
  rejectSkill,
  type SkillReviewItem,
} from "@/actions/admin/agent-skills.actions"
import type { SkillScanFindings } from "@/lib/db/schema/tables/agent-skills"

function ScanFindingsDisplay({ findings }: { findings: SkillScanFindings }) {
  const hasSecrets = findings.secrets && findings.secrets.length > 0
  const hasPii = findings.pii && findings.pii.length > 0
  const hasAudit = findings.npmAudit && findings.npmAudit.length > 0
  const hasLint = findings.skillMdLint && findings.skillMdLint.length > 0

  if (!hasSecrets && !hasPii && !hasAudit && !hasLint) return null

  return (
    <div className="mb-4 space-y-2">
      <p className="text-sm font-medium">Scan Findings:</p>
      {hasSecrets && (
        <div className="text-sm text-destructive">
          <strong>Secrets:</strong> {findings.secrets!.join(", ")}
        </div>
      )}
      {hasPii && (
        <div className="text-sm text-destructive">
          <strong>PII:</strong> {findings.pii!.join(", ")}
        </div>
      )}
      {hasAudit && (
        <div className="text-sm text-destructive">
          <strong>npm vulnerabilities:</strong>{" "}
          {findings.npmAudit!.map((a) => `${a.severity}: ${a.title}`).join(", ")}
        </div>
      )}
      {hasLint && (
        <div className="text-sm text-yellow-600">
          <strong>SKILL.md issues:</strong> {findings.skillMdLint!.join(", ")}
        </div>
      )}
    </div>
  )
}

function RejectDialog({
  open,
  onOpenChange,
  onSubmit,
  rejecting,
  reason,
  onReasonChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: () => Promise<void>
  rejecting: boolean
  reason: string
  onReasonChange: (reason: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reject Skill</DialogTitle>
          <DialogDescription>
            Provide a reason for rejecting this skill. The author will see this in
            the audit log.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reject-reason">Reason</Label>
          <Textarea
            id="reject-reason"
            placeholder="Enter rejection reason..."
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            maxLength={1000}
            rows={4}
          />
          <p className="text-xs text-muted-foreground text-right">
            {reason.length}/1000
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={rejecting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onSubmit}
            disabled={rejecting || !reason.trim()}
          >
            {rejecting ? "Rejecting..." : "Reject Skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SkillReviewClient() {
  const { toast } = useToast()
  const [items, setItems] = useState<SkillReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false)
  const [rejectSkillId, setRejectSkillId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState("")
  const [rejecting, setRejecting] = useState(false)

  const loadQueue = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getSkillReviewQueue()
      if (result.isSuccess && result.data) {
        setItems(result.data)
      } else {
        toast({
          title: "Error",
          description: result.message || "Failed to load review queue",
          variant: "destructive",
        })
      }
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    loadQueue()
  }, [loadQueue])

  const handleApprove = async (skillId: string) => {
    const result = await approveSkillToShared(skillId)
    if (result.isSuccess) {
      toast({ title: "Skill approved to shared" })
      loadQueue()
    } else {
      toast({
        title: "Error",
        description: result.message || "Failed to approve",
        variant: "destructive",
      })
    }
  }

  const handleRejectSubmit = async () => {
    if (!rejectSkillId || !rejectReason.trim()) return

    setRejecting(true)
    try {
      const result = await rejectSkill(rejectSkillId, rejectReason.trim())
      if (result.isSuccess) {
        toast({ title: "Skill rejected" })
        setRejectDialogOpen(false)
        loadQueue()
      } else {
        toast({
          title: "Error",
          description: result.message || "Failed to reject",
          variant: "destructive",
        })
      }
    } finally {
      setRejecting(false)
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <PageBranding />
        <h1 className="text-2xl font-bold">Skill Review Queue</h1>
        <p className="text-muted-foreground text-sm">Review flagged and submitted skills</p>
      </div>

      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={loadQueue} disabled={loading}>
          <IconRefresh className="h-4 w-4 mr-1" />
          Refresh
        </Button>
        <span className="text-sm text-muted-foreground">
          {items.length} item{items.length !== 1 ? "s" : ""} pending review
        </span>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            {loading ? "Loading..." : "No items pending review"}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <Card key={item.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-lg">{item.name}</CardTitle>
                    <CardDescription>{item.summary}</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={item.scanStatus === "flagged" ? "destructive" : "outline"}>
                      {item.scanStatus}
                    </Badge>
                    <Badge variant="secondary">{item.scope}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {item.scanFindings && <ScanFindingsDisplay findings={item.scanFindings} />}

                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
                  <span>Owner: {item.ownerUserId ?? "N/A"}</span>
                  <span>&middot;</span>
                  <span>Created: {new Date(item.createdAt).toLocaleString()}</span>
                </div>

                <div className="flex gap-2">
                  <Button size="sm" onClick={() => handleApprove(item.id)}>
                    <IconCheck className="h-4 w-4 mr-1" />
                    Approve to Shared
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      setRejectSkillId(item.id)
                      setRejectReason("")
                      setRejectDialogOpen(true)
                    }}
                  >
                    <IconX className="h-4 w-4 mr-1" />
                    Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <RejectDialog
        open={rejectDialogOpen}
        onOpenChange={setRejectDialogOpen}
        onSubmit={handleRejectSubmit}
        rejecting={rejecting}
        reason={rejectReason}
        onReasonChange={setRejectReason}
      />
    </div>
  )
}
