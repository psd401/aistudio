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
 * uses `Promise.allSettled` over a bounded pool and aggregates the outcome into
 * ONE message instead of a toast storm.
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
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "LibraryBulkBar" });

/**
 * Max in-flight server actions during a fan-out. Bounded so selecting a full
 * 50-row page cannot open 50 simultaneous requests (each of which takes a DB
 * connection from the pool).
 */
const BULK_CONCURRENCY = 4;

/** The outcome of one bulk fan-out. */
interface BulkOutcome {
  succeeded: number;
  /** One message per failed id, deduped by message with a count. */
  failures: Map<string, number>;
}

/**
 * Run `task` over `ids` with bounded concurrency, collecting per-id outcomes.
 * Never rejects: a thrown task is recorded as a failure like any other, so one
 * network error cannot abandon the rest of the selection.
 */
async function runBounded(
  ids: string[],
  task: (id: string) => Promise<{ isSuccess: boolean; message?: string }>
): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { succeeded: 0, failures: new Map() };
  const queue = [...ids];

  const recordFailure = (message: string) => {
    outcome.failures.set(message, (outcome.failures.get(message) ?? 0) + 1);
  };

  async function worker(): Promise<void> {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      try {
        const res = await task(id);
        if (res.isSuccess) outcome.succeeded += 1;
        else recordFailure(res.message ?? "Refused by the server");
      } catch (e) {
        log.error("bulk task threw", {
          error: e instanceof Error ? e.message : String(e),
        });
        recordFailure("Request failed — please try again");
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(BULK_CONCURRENCY, ids.length) }, worker)
  );
  return outcome;
}

/** Render one aggregated sentence from a fan-out outcome. */
function summarize(outcome: BulkOutcome, verb: string, total: number): string {
  const { succeeded, failures } = outcome;
  if (failures.size === 0) {
    return `${verb} ${succeeded} ${succeeded === 1 ? "item" : "items"}.`;
  }
  const failed = total - succeeded;
  const reasons = [...failures.entries()]
    .map(([message, count]) => (count > 1 ? `${message} (×${count})` : message))
    .join("; ");
  if (succeeded === 0) {
    return `Could not ${verb.toLowerCase()} ${failed} ${
      failed === 1 ? "item" : "items"
    }: ${reasons}`;
  }
  return `${verb} ${succeeded} of ${total}. ${failed} failed: ${reasons}`;
}

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
  /** Clear the selection (the "×" control and the post-action reset). */
  onClear: () => void;
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
        const outcome = await runBounded(ids, task);
        setMessage(summarize(outcome, verb, ids.length));
        if (outcome.succeeded > 0) onRefresh();
        // Keep the selection when NOTHING succeeded so the user can retry or
        // narrow it; clear it once the grid has actually changed underneath.
        if (clearOnDone && outcome.succeeded > 0) onClear();
      } finally {
        setBusy(false);
      }
    },
    [selectedIds, onClear, onRefresh]
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

  if (count === 0) return null;

  return (
    <div className="mer-bulk-bar" role="region" aria-label="Bulk actions">
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

      {(busy || message) && (
        <p className="mer-bulk-message" role="status" data-testid="bulk-message">
          {busy ? "Working…" : message}
        </p>
      )}
    </div>
  );
}
