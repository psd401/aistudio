"use client"

/**
 * Edit a registered client's redirect URIs, and reactivate it if it was revoked.
 *
 * Before this existed the admin surface was create/list/revoke only, and the
 * actions column rendered nothing at all once a client was inactive. A client
 * whose redirect list was wrong therefore could not be corrected — on
 * 2026-08-10 one stale `http://localhost:3000/...` entry took agent-connect
 * down for every user, revoking was the only available control, and repairing
 * the row needed a migration and a deploy (see migration 176).
 *
 * Scope matches the server action: redirect URIs and active state only. The
 * security profile (application type, auth method, PKCE, secret, scopes) still
 * requires registering a new client, because changing it on a live
 * registration silently alters what an already-issued grant means.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Pencil } from "lucide-react"
import { updateOAuthClientRedirectUris } from "@/actions/oauth/oauth-client.actions"
import type { OAuthClientRow } from "@/actions/oauth/oauth-client.actions"
import { meridianPortalClassName } from "@/lib/meridian/fonts"

export function EditRedirectUrisDialog({
  client,
  onSaved,
}: {
  client: OAuthClientRow
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(client.redirectUris.join("\n"))
  const [reactivate, setReactivate] = useState(!client.isActive)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    setError(null)
    const redirectUris = value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    const result = await updateOAuthClientRedirectUris({
      clientId: client.clientId,
      redirectUris,
      ...(client.isActive ? {} : { isActive: reactivate }),
    })
    setSaving(false)

    if (!result.isSuccess) {
      // The validator's message names the offending URI and why it was
      // rejected. Show it verbatim — the admin typed these and cannot fix them
      // from a generic failure.
      setError(result.message || "Failed to update client")
      return
    }
    setOpen(false)
    onSaved()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          // Reopening after a failed edit should show what is stored, not the
          // rejected draft.
          setValue(client.redirectUris.join("\n"))
          setReactivate(!client.isActive)
          setError(null)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Edit redirect URIs">
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className={`sm:max-w-lg ${meridianPortalClassName}`}>
        <DialogHeader>
          <DialogTitle>Edit redirect URIs</DialogTitle>
          <DialogDescription>
            One URI per line for &quot;{client.clientName}&quot;. Rules follow
            the client&apos;s registered type ({client.applicationType}) — a
            native client, for example, must use a literal{" "}
            <code>127.0.0.1</code> or <code>[::1]</code> for HTTP callbacks,
            never <code>localhost</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="redirect-uris">Redirect URIs</Label>
            <Textarea
              id="redirect-uris"
              rows={5}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="font-mono text-xs"
            />
          </div>

          {!client.isActive && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="reactivate"
                checked={reactivate}
                onCheckedChange={(checked) => setReactivate(checked === true)}
              />
              <Label htmlFor="reactivate" className="font-normal">
                Reactivate this client
              </Label>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="text-sm text-destructive whitespace-pre-wrap"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
