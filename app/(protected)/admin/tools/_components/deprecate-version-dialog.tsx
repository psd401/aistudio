"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { deprecateToolVersionAction } from "@/actions/admin/tool-versions.actions"
import type { ToolVersionWithUsage } from "@/lib/db/drizzle"

const DEFAULT_GRACE_DAYS = 90

interface DeprecateVersionDialogProps {
  version: ToolVersionWithUsage
  /** Called on close; `didChange` is true after a successful deprecation. */
  onClose: (didChange: boolean) => void
}

/**
 * Deprecate-a-version dialog (Issue #927). Captures the successor `replaced_by`
 * pin and the grace period, then calls the admin action. Validation mirrors the
 * server action (which re-validates) — the client checks are for UX only.
 */
export function DeprecateVersionDialog({
  version,
  onClose,
}: DeprecateVersionDialogProps) {
  const { toast } = useToast()
  const [replacedBy, setReplacedBy] = useState("")
  const [gracePeriodDays, setGracePeriodDays] = useState(String(DEFAULT_GRACE_DAYS))
  const [pending, startTransition] = useTransition()

  const ref = `${version.identifier}@${version.version}`

  const handleSubmit = () => {
    const days = Number(gracePeriodDays)
    if (!Number.isInteger(days) || days < 1) {
      toast({
        title: "Invalid grace period",
        description: "Grace period must be a positive whole number of days.",
        variant: "destructive",
      })
      return
    }
    startTransition(async () => {
      const result = await deprecateToolVersionAction({
        identifier: version.identifier,
        version: version.version,
        replacedBy: replacedBy.trim() || null,
        gracePeriodDays: days,
      })
      if (result.isSuccess) {
        toast({
          title: "Deprecated",
          description: `${ref} will be removable after ${formatRemoval(
            result.data.removalDate
          )}.`,
        })
        onClose(true)
      } else {
        toast({ title: "Error", description: result.message, variant: "destructive" })
      }
    })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deprecate {ref}</DialogTitle>
          <DialogDescription>
            The version stays callable during the grace period but emits a
            deprecation warning on every invocation. After the removal date you can
            remove it permanently.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="replaced-by">Replaced by (optional)</Label>
            <Input
              id="replaced-by"
              placeholder="documents.create@v2"
              value={replacedBy}
              onChange={(e) => setReplacedBy(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The successor version callers should migrate to. Must be a pinned
              reference like <code>documents.create@v2</code>.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="grace-days">Grace period (days)</Label>
            <Input
              id="grace-days"
              type="number"
              min={1}
              value={gracePeriodDays}
              onChange={(e) => setGracePeriodDays(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Minimum days before the version can be removed. Default {DEFAULT_GRACE_DAYS}.
            </p>
          </div>
          {version.usage.skillCount + version.usage.assistantPromptCount > 0 && (
            <p className="text-sm text-amber-600">
              In use by {version.usage.skillCount} skill(s) and{" "}
              {version.usage.assistantPromptCount} assistant prompt(s). They will
              keep working until removal.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? "Deprecating…" : "Deprecate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Format the removal date returned by the action (Date | string | null). */
function formatRemoval(value: Date | string | null): string {
  if (!value) return "the grace period"
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return "the grace period"
  return date.toISOString().slice(0, 10)
}
