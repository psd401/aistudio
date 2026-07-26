"use client";

/**
 * Atrium LibraryBulkBar — multi-select bulk actions for the content library
 * (#1336).
 *
 * DELIBERATELY a client-side fan-out of the EXISTING single-id server actions
 * (`updateContentAction` / `deleteContentAction`) rather than new bulk
 * endpoints: every per-object authorization gate (capability check, canView,
 * assertCanEdit / assertCanDelete, the published-object delete refusal) already
 * lives in those actions and runs unchanged per id. A bulk endpoint would have
 * to re-implement all of it, so there is no server change here at all.
 *
 * Partial failure is the normal case (e.g. bulk-deleting a mixed selection:
 * published objects are refused with a 409 while drafts succeed), so the fan-out
 * runs a bounded worker pool that never rejects (`runBounded` in
 * `lib/atrium/bulk-run.ts`) and aggregates the outcome into ONE message instead
 * of a toast storm. After a run, only the ids that actually SUCCEEDED are
 * dropped from the selection: failed ids stay selected for retry, and picks the
 * user made while the fan-out was in flight are never touched.
 */

import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, FolderInput, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import {
  flattenTree,
  NO_COLLECTION,
  type CollectionOption,
} from "@/lib/atrium/collection-options";
import { summarize } from "@/lib/atrium/bulk-summary";
import { runBounded } from "@/lib/atrium/bulk-run";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "LibraryBulkBar" });

/**
 * Load the visibility-filtered move-target sections once a selection exists —
 * the SAME source as the library sidebar and the editor settings dialog.
 * Extracted so the component body stays under the max-lines lint.
 */
function useCollectionOptions(enabled: boolean): CollectionOption[] {
  const [options, setOptions] = useState<CollectionOption[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await collectionTreeAction();
        if (cancelled) return;
        if (res.isSuccess) setOptions(flattenTree(res.data));
        else log.warn("collectionTreeAction failed", { message: res.message });
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
  }, [enabled]);
  return options;
}

/**
 * The bulk-action controls. Presentational — every handler and all busy state
 * lives in `LibraryBulkBar`. Extracted so both bodies stay under the
 * max-lines-per-function lint.
 */
function BulkControls({
  count,
  busy,
  archivedView,
  options,
  onArchive,
  onRestore,
  onMove,
  onDelete,
  onClear,
}: {
  count: number;
  busy: boolean;
  archivedView: boolean;
  options: CollectionOption[];
  onArchive: () => void;
  onRestore: () => void;
  onMove: (value: string) => void;
  onDelete: () => void;
  onClear: () => void;
}): React.JSX.Element {
  return (
    <div className="mer-bulk-bar-row">
      <span className="mer-bulk-count" data-testid="bulk-count">
        {count} selected
      </span>

      {archivedView ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onRestore}
          data-testid="bulk-restore"
        >
          <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
          Restore
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onArchive}
          data-testid="bulk-archive"
        >
          <Archive className="h-4 w-4" aria-hidden="true" />
          Archive
        </Button>
      )}

      {/* An ACTION menu, not a state select: `value` stays "" so the trigger
          always shows the placeholder and re-picking the same section fires
          again. */}
      <Select value="" onValueChange={onMove} disabled={busy}>
        <SelectTrigger className="h-8 w-48" data-testid="bulk-move">
          <FolderInput className="h-4 w-4" aria-hidden="true" />
          <SelectValue placeholder="Move to section…" />
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

      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={onDelete}
        className="text-destructive hover:text-destructive"
        data-testid="bulk-delete"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        Delete
      </Button>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={onClear}
        aria-label="Clear selection"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

export interface LibraryBulkBarProps {
  /** The selected object ids (order is irrelevant). */
  selectedIds: string[];
  /** Clear the WHOLE selection (the "×" control only). */
  onClear: () => void;
  /**
   * Remove exactly these ids from the selection after a bulk action succeeded
   * on them. Deliberately NOT `onClear`: the user can keep selecting while a
   * fan-out is in flight, and a whole-selection reset would silently discard
   * those mid-flight picks (and deselect failed ids the user may want to
   * retry).
   */
  onActed: (ids: string[]) => void;
  /** Reload the current page after a mutation so the grid reflects reality. */
  onRefresh: () => void;
  /**
   * The Archived filter is active, so the useful verb is Restore rather than
   * Archive (you cannot archive an already-archived object).
   */
  archivedView: boolean;
}

export function LibraryBulkBar({
  selectedIds,
  onClear,
  onActed,
  onRefresh,
  archivedView,
}: LibraryBulkBarProps): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const count = selectedIds.length;
  const options = useCollectionOptions(count > 0);

  const run = useCallback(
    async (
      verb: string,
      task: (id: string) => Promise<{ isSuccess: boolean; message?: string }>,
      { clearOnDone = true }: { clearOnDone?: boolean } = {}
    ) => {
      const ids = [...selectedIds];
      setBusy(true);
      setMessage(null);
      try {
        const { outcome, succeededIds } = await runBounded(ids, task, (id, e) =>
          log.error("bulk task threw", {
            id,
            error: e instanceof Error ? e.message : String(e),
          })
        );
        setMessage(summarize(outcome, verb, ids.length));
        if (outcome.succeeded > 0) onRefresh();
        // Deselect ONLY the ids that succeeded: failed ids stay selected for
        // retry, and any picks made while the fan-out was in flight survive.
        if (clearOnDone && succeededIds.length > 0) onActed(succeededIds);
      } finally {
        setBusy(false);
      }
    },
    [selectedIds, onActed, onRefresh]
  );

  const setStatus = useCallback(
    (status: "archived" | "draft", verb: string) =>
      run(verb, (id) => updateContentAction(id, { status })),
    [run]
  );

  const move = useCallback(
    (value: string) =>
      run("Moved", (id) =>
        updateContentAction(id, {
          collectionId: value === NO_COLLECTION ? null : value,
        })
      ),
    [run]
  );

  const remove = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Permanently delete ${count} ${count === 1 ? "item" : "items"}? This removes ` +
          "them and ALL of their versions, comments, and history for everyone, and " +
          "CANNOT be undone. Published items are refused — unpublish or archive " +
          "them first. To keep items recoverable instead, use Archive."
      )
    ) {
      return;
    }
    void run("Deleted", (id) => deleteContentAction(id));
  }, [count, run]);

  // Render while anything is selected OR while an outcome message is still
  // pending. The bar used to unmount the instant the selection cleared, which
  // is exactly when a successful bulk action finishes — so the aggregated
  // "Deleted 1 of 2. 1 failed: …" sentence was destroyed at the moment it
  // became useful.
  if (count === 0 && !message && !busy) return null;

  return (
    <div className="mer-bulk-bar" role="region" aria-label="Bulk actions">
      {count > 0 && (
        <BulkControls
          count={count}
          busy={busy}
          archivedView={archivedView}
          options={options}
          onArchive={() => void setStatus("archived", "Archived")}
          onRestore={() => void setStatus("draft", "Restored")}
          onMove={(v) => void move(v)}
          onDelete={remove}
          onClear={onClear}
        />
      )}

      {(busy || message) && (
        <p className="mer-bulk-message" role="status" data-testid="bulk-message">
          {busy ? "Working…" : message}
        </p>
      )}
    </div>
  );
}
