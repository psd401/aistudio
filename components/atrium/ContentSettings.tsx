"use client";

/**
 * Atrium ContentSettings — the editor-header settings dialog (Epic #1059
 * completion)
 *
 * The metadata surface `contentService.update` has had since Phase 0 but the UI
 * could not reach: rename the title, edit tags, move the object to another
 * collection, and archive/restore — plus a permanent hard DELETE (via
 * `deleteContentAction`). Persists via `updateContentAction` / `deleteContentAction`
 * (which run the capability gate + the service's canView/assertCanEdit/assertCanDelete
 * gates server-side), so this component is presentation only. Delete is disabled
 * for a published object (unpublish/archive first); the server refuses it
 * authoritatively with a 409 regardless.
 *
 * The collection options come from `collectionTreeAction` — the SAME
 * visibility-filtered source the LibraryView sidebar uses — flattened with a
 * depth prefix so the hierarchy is readable in a flat select. On archive the
 * caller is navigated back to `/atrium` (the object disappears from default
 * lists); restore returns it to `draft`. Successful saves call
 * `router.refresh()` so the server-rendered header (title) updates.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateContentAction } from "@/actions/db/atrium/update-content";
import { deleteContentAction } from "@/actions/db/atrium/delete-content";
import { collectionTreeAction } from "@/actions/db/atrium/collection-tree";
import { meridianPortalClassName } from "@/lib/atrium/meridian-fonts";
import type { CollectionTreeNode } from "@/lib/content";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "ContentSettings" });

/**
 * Radix Select items cannot carry an empty-string value, so "no section" is a
 * sentinel mapped to `null` at save time. Not a plausible collection UUID.
 */
const NO_COLLECTION = "__none__";

/** One flattened collection option (depth drives the indent prefix). */
interface CollectionOption {
  id: string;
  label: string;
}

/** Depth-first flatten of the visibility-filtered tree into select options. */
function flattenTree(
  nodes: CollectionTreeNode[],
  depth = 0,
  out: CollectionOption[] = []
): CollectionOption[] {
  for (const node of nodes) {
    out.push({ id: node.id, label: `${"— ".repeat(depth)}${node.name}` });
    flattenTree(node.children, depth + 1, out);
  }
  return out;
}

/**
 * Persist a settings patch and apply the resulting local/navigation state.
 * Module-level with the component's setters threaded in (mirrors
 * VisibilityChip's performVisibilitySave) so the component body stays under the
 * max-lines-per-function lint. On success: close the dialog, then either
 * navigate back to the library (an archive removes the object from default
 * lists) or `router.refresh()` so the server-rendered header reflects the
 * change. The try/catch/finally guarantees `setSaving(false)` even when the
 * server action THROWS (network error) — the dialog is never stranded saving.
 */
async function runUpdate(
  patch: Parameters<typeof updateContentAction>[1],
  ctx: {
    objectId: string;
    router: ReturnType<typeof useRouter>;
    setSaving: (v: boolean) => void;
    setError: (v: string | null) => void;
    setOpen: (v: boolean) => void;
  }
): Promise<void> {
  const { objectId, router, setSaving, setError, setOpen } = ctx;
  setSaving(true);
  setError(null);
  try {
    const res = await updateContentAction(objectId, patch);
    if (res.isSuccess) {
      setOpen(false);
      if (patch.status === "archived") {
        router.push("/atrium");
      } else {
        router.refresh();
      }
    } else {
      setError(res.message ?? "Could not save settings");
      log.warn("updateContentAction failed", { message: res.message });
    }
  } catch (e) {
    setError("Could not save settings — please try again.");
    log.error("updateContentAction threw", {
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    setSaving(false);
  }
}

/**
 * Confirm + run a permanent hard delete, then navigate. Module-level with the
 * component's setters threaded in (mirrors `runUpdate`) so the component body stays
 * under the max-lines-per-function lint. The `window.confirm` states permanence;
 * on success the object is gone from every list and its routes 404, so we navigate
 * back to the library. The server re-checks owner/admin and refuses (409) a still-
 * published object regardless of the client-side disabled hint.
 */
async function runDelete(
  objectId: string,
  ctx: {
    router: ReturnType<typeof useRouter>;
    setDeleting: (v: boolean) => void;
    setError: (v: string | null) => void;
    setOpen: (v: boolean) => void;
  }
): Promise<void> {
  const { router, setDeleting, setError, setOpen } = ctx;
  if (
    typeof window !== "undefined" &&
    !window.confirm(
      "Permanently delete this content? This removes it and ALL of its versions, " +
        "comments, and history for everyone, and CANNOT be undone. To keep it " +
        "recoverable instead, use Archive."
    )
  ) {
    return;
  }
  setDeleting(true);
  setError(null);
  try {
    const res = await deleteContentAction(objectId);
    if (res.isSuccess) {
      setOpen(false);
      router.push("/atrium");
    } else {
      setError(res.message ?? "Could not delete this content");
      log.warn("deleteContentAction failed", { message: res.message });
    }
  } catch (e) {
    setError("Could not delete this content — please try again.");
    log.error("deleteContentAction threw", {
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    setDeleting(false);
  }
}

/**
 * The "Danger zone" hard-delete row. Extracted from ContentSettings so its body
 * stays under the max-lines-per-function lint (mirrors SettingsFields). Delete is
 * disabled while a publication is live (a published object must be
 * unpublished/archived first); the server enforces the same refusal authoritatively.
 */
function DangerZone({
  status,
  deleting,
  busy,
  onDelete,
}: {
  status: "draft" | "published" | "archived";
  deleting: boolean;
  busy: boolean;
  onDelete: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5 border-t border-border/60 pt-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || status === "published"}
          onClick={onDelete}
          className="text-destructive hover:text-destructive"
        >
          {deleting ? "Deleting…" : "Delete permanently"}
        </Button>
        {status === "published" && (
          <span className="text-xs text-muted-foreground">
            Unpublish or archive it before deleting.
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Permanently removes this content and all of its versions and history. This
        cannot be undone — use Archive to keep it recoverable.
      </p>
    </div>
  );
}

/** Parse the comma-separated tags input into trimmed, deduped tags. */
function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim();
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

export interface ContentSettingsProps {
  /** The object's stable UUID (the server page passes `obj.id`). */
  objectId: string;
  title: string;
  tags: string[];
  collectionId: string | null;
  status: "draft" | "published" | "archived";
}

/**
 * The dialog's form fields (title / tags / section) + the archive-restore row.
 * Extracted from ContentSettings so its body stays under the
 * max-lines-per-function lint; purely presentational — state lives in the parent.
 */
function SettingsFields({
  draftTitle,
  onTitle,
  draftTags,
  onTags,
  draftCollection,
  onCollection,
  options,
  status,
  saving,
  onStatus,
}: {
  draftTitle: string;
  onTitle: (v: string) => void;
  draftTags: string;
  onTags: (v: string) => void;
  draftCollection: string;
  onCollection: (v: string) => void;
  options: CollectionOption[];
  status: "draft" | "published" | "archived";
  saving: boolean;
  onStatus: (next: "draft" | "archived") => void;
}): React.JSX.Element {
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="content-settings-title">Title</Label>
        <Input
          id="content-settings-title"
          value={draftTitle}
          onChange={(e) => onTitle(e.target.value)}
          disabled={saving}
          maxLength={500}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="content-settings-tags">Tags</Label>
        <Input
          id="content-settings-tags"
          value={draftTags}
          onChange={(e) => onTags(e.target.value)}
          placeholder="Comma-separated, e.g. policy, handbook"
          disabled={saving}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="content-settings-collection">Section</Label>
        <Select value={draftCollection} onValueChange={onCollection} disabled={saving}>
          <SelectTrigger id="content-settings-collection">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={meridianPortalClassName}>
            <SelectItem value={NO_COLLECTION}>No section</SelectItem>
            {options.map((opt) => (
              <SelectItem key={opt.id} value={opt.id}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Sections you may enter (the same list as the library sidebar).
        </p>
      </div>

      <div className="flex items-center gap-2">
        {status === "archived" ? (
          <>
            <Badge variant="outline">Archived</Badge>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={saving}
              onClick={() => onStatus("draft")}
            >
              Restore
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => onStatus("archived")}
            className="text-destructive hover:text-destructive"
          >
            Archive
          </Button>
        )}
      </div>
    </>
  );
}

export function ContentSettings({
  objectId,
  title,
  tags,
  collectionId,
  status,
}: ContentSettingsProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Draft state, re-seeded from props each time the dialog opens (the server
  // page re-renders after router.refresh(), so props are the persisted truth).
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftTags, setDraftTags] = useState(tags.join(", "));
  const [draftCollection, setDraftCollection] = useState(
    collectionId ?? NO_COLLECTION
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [options, setOptions] = useState<CollectionOption[]>([]);

  // Load the collection options when the dialog opens (same data source as the
  // library sidebar). No init-guard ref needed: `open` gates the fetch, and a
  // transient failure retries on the next open. A `cancelled` flag drops a late
  // resolve after close/unmount.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await collectionTreeAction();
        if (cancelled) return;
        if (res.isSuccess) {
          setOptions(flattenTree(res.data));
        } else {
          log.warn("collectionTreeAction failed", { message: res.message });
        }
      } catch (e) {
        if (cancelled) return;
        log.error("collectionTreeAction threw", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset drafts to the persisted values on open/close so a dismissed dialog
  // never shows stale unsaved edits next time (mirrors VisibilityChip).
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        setDraftTitle(title);
        setDraftTags(tags.join(", "));
        setDraftCollection(collectionId ?? NO_COLLECTION);
        setError(null);
      }
      setOpen(next);
    },
    [title, tags, collectionId]
  );

  const save = useCallback(async () => {
    if (!draftTitle.trim()) {
      setError("Title cannot be empty.");
      return;
    }
    await runUpdate(
      {
        title: draftTitle.trim(),
        tags: parseTags(draftTags),
        collectionId: draftCollection === NO_COLLECTION ? null : draftCollection,
      },
      { objectId, router, setSaving, setError, setOpen }
    );
  }, [objectId, draftTitle, draftTags, draftCollection, router]);

  // Archive (with confirm — it removes the object from default library lists)
  // and Restore (back to draft). Archive navigates back to the library
  // (`runUpdate` routes an archive to `/atrium`).
  const setStatus = useCallback(
    async (nextStatus: "draft" | "archived") => {
      if (
        nextStatus === "archived" &&
        typeof window !== "undefined" &&
        !window.confirm(
          "Archive this content? It will be taken offline everywhere it is published (intranet and public web) and hidden from the library. You can restore and republish it later."
        )
      ) {
        return;
      }
      await runUpdate(
        { status: nextStatus },
        { objectId, router, setSaving, setError, setOpen }
      );
    },
    [objectId, router]
  );

  // Hard delete (permanent). Confirms permanence, then navigates back to the
  // library on success (the object is gone from every list and its routes 404).
  // Extracted to the module-level `runDelete` to keep this component under the
  // max-lines-per-function lint.
  const deleteContent = useCallback(
    () => runDelete(objectId, { router, setDeleting, setError, setOpen }),
    [objectId, router]
  );

  const busy = saving || deleting;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="mer-ectl mer-ectl-icon"
          aria-label="Content settings"
          title="Content settings"
        >
          <Settings2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent className={meridianPortalClassName}>
        <DialogHeader>
          <DialogTitle>Content settings</DialogTitle>
          <DialogDescription>
            Rename, tag, move, archive, or permanently delete this content. Body
            changes are made in the editor.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <SettingsFields
            draftTitle={draftTitle}
            onTitle={setDraftTitle}
            draftTags={draftTags}
            onTags={setDraftTags}
            draftCollection={draftCollection}
            onCollection={setDraftCollection}
            options={options}
            status={status}
            saving={busy}
            onStatus={(next) => void setStatus(next)}
          />

          {/* Danger zone — permanent hard delete (extracted sub-component). */}
          <DangerZone
            status={status}
            deleting={deleting}
            busy={busy}
            onDelete={() => void deleteContent()}
          />

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={busy}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
