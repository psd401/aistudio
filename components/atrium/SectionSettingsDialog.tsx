"use client";

/**
 * "Edit this page" — the section landing page's own settings.
 *
 * ## Why it lives here and not in the admin collection panel
 *
 * This edits the two things you can SEE on the landing page: the description in
 * the hero and which page is pinned to the top. Editing them anywhere else means
 * writing hero copy while looking at a table of collection rows. The admin panel
 * keeps what it is actually for — structure: name, parent, order, and grants.
 *
 * ## Who can open it
 *
 * Anyone with `create` access to the section (`node.selectableForCreate`), not
 * only administrators. `collectionManagementService.update` enforces the same
 * split server-side via `SECTION_EDITOR_FIELDS`: a patch touching only these two
 * fields waives the district-admin requirement, and any other field still
 * requires an administrator. Describing the section you contribute to should not
 * need an admin; restructuring it still does.
 */

import { useCallback, useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { updateCollectionAction } from "@/actions/db/atrium/collection-management";
import { listContentAction } from "@/actions/db/atrium/list-content";
import type { ContentObjectDTO } from "@/lib/content";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "SectionSettingsDialog" });

const DESCRIPTION_MAX = 2000;

export interface SectionSettingsDialogProps {
  collectionId: string;
  sectionName: string;
  initialDescription: string | null;
  initialLandingObjectId: string | null;
}

export function SectionSettingsDialog({
  collectionId,
  sectionName,
  initialDescription,
  initialLandingObjectId,
}: SectionSettingsDialogProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(initialDescription ?? "");
  const [landingObjectId, setLandingObjectId] = useState(
    initialLandingObjectId ?? ""
  );
  const [options, setOptions] = useState<ContentObjectDTO[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the pin candidates only while the dialog is open — the landing page
  // already paid for its own listing, and this is a different (unpaginated,
  // title-only) shape.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      // Inside the IIFE, not synchronously in the effect body: a synchronous
      // setState in an effect triggers a cascading render (and the lint that
      // guards against it). This is the pattern the rest of the codebase uses.
      setLoadingOptions(true);
      try {
        const res = await listContentAction({ collectionId, limit: 100 });
        if (!cancelled && res.isSuccess) setOptions(res.data);
      } catch (e) {
        // A failed load leaves the pin picker empty; the description still saves.
        if (!cancelled) {
          setOptions([]);
          log.warn("pin options load failed", {
            collectionId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (!cancelled) setLoadingOptions(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, collectionId]);

  const save = useCallback(() => {
    setSaving(true);
    setError(null);
    void (async () => {
      try {
        const res = await updateCollectionAction(collectionId, {
          // Empty string CLEARS (the service maps blank to null). Sending
          // `undefined` would drop the column from the UPDATE and silently keep
          // the old copy while the form showed it as cleared.
          description,
          landingObjectId: landingObjectId || null,
        });
        if (res.isSuccess) {
          setOpen(false);
          // A server component renders the hero, so a client state update cannot
          // show the new copy. Reload rather than mirror the value locally and
          // risk the page and the form disagreeing.
          window.location.reload();
          return;
        }
        setError(res.message ?? "Could not save these settings");
      } catch (e) {
        setError("Could not save these settings");
        log.error("updateCollectionAction threw", {
          collectionId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      setSaving(false);
    })();
  }, [collectionId, description, landingObjectId]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="mer-btn" data-testid="section-settings">
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          Edit this page
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{sectionName}</DialogTitle>
          <DialogDescription>
            What people see at the top of this section, and which page they
            should read first.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="section-description">Description</Label>
            <textarea
              id="section-description"
              className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={description}
              maxLength={DESCRIPTION_MAX}
              disabled={saving}
              placeholder="What belongs in this section, and who it is for."
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="section-landing">Start here</Label>
            <select
              id="section-landing"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={landingObjectId}
              disabled={saving || loadingOptions}
              onChange={(e) => setLandingObjectId(e.target.value)}
              data-testid="section-start-here"
            >
              <option value="">No pinned page</option>
              {/* A pin at something no longer in this section (it was moved)
                  would otherwise vanish from the list and silently reset to
                  "none" on the next save. Keep it visible and clearable. */}
              {landingObjectId &&
                !options.some((o) => o.id === landingObjectId) && (
                  <option value={landingObjectId}>
                    Currently pinned page (no longer in this section)
                  </option>
                )}
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {loadingOptions
                ? "Loading this section's pages…"
                : options.length === 0
                  ? "This section has no pages yet."
                  : "Pinned above everything else, so the page to read first is not buried by whatever changed most recently."}
            </p>
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default SectionSettingsDialog;
