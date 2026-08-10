/**
 * The changes-feed reconcile loop, expressed against injected collaborators
 * so it can be exercised without a database, Google credentials, or the
 * Lambda's module-level environment requirements.
 *
 * The invariant this module exists to protect: the cursor advances page by
 * page, ALWAYS, and the obligation to rebuild the selection snapshot is
 * recorded durably instead of being implied by a cursor that was left behind.
 *
 * Before this split, a page that demanded a snapshot suppressed every
 * per-page cursor write until the snapshot finished. A 900s Lambda timeout or
 * a snapshot budget failure therefore threw away all the change-page work and
 * replayed it from the original cursor on the next attempt — indefinitely, if
 * the snapshot kept failing.
 */

/** The connector-metadata slice that carries the snapshot obligation. */
export interface SnapshotObligationMetadata {
  selectionSnapshotPendingAt?: string;
}

export function isSelectionSnapshotPending(
  metadata: SnapshotObligationMetadata | null | undefined,
): boolean {
  return typeof metadata?.selectionSnapshotPendingAt === "string";
}

/** The jsonb key the durable flag is stored under. */
export const SELECTION_SNAPSHOT_PENDING_KEY = "selectionSnapshotPendingAt";

/**
 * Retiring sources that a snapshot did not see is only sound after a COMPLETE
 * enumeration.
 *
 * Per-entry validation drops entries Google returned in a shape this client
 * cannot read. A dropped entry says nothing about whether its file still
 * exists, so a file could be absent from the seen set purely because one
 * record was unreadable — and marking it missing would be silent data loss.
 * When anything was dropped, the sweep is skipped and left to the next clean
 * snapshot.
 */
export function shouldRetireUnseenSources(enumeration: {
  skippedEntryCount: number;
}): boolean {
  return enumeration.skippedEntryCount === 0;
}

export interface ChangesPage<TChange> {
  values: TChange[];
  nextPageToken: string | null;
  newStartPageToken: string | null;
}

export interface ReconcileChangesDeps<TChange> {
  listChanges(cursor: string): Promise<ChangesPage<TChange>>;
  /**
   * Handles one change entry. Returns true when the entry obligates a full
   * selection snapshot (a Shared Drive went away).
   */
  processChange(change: TChange): Promise<boolean>;
  /** Advance the durable cursor. */
  persistCursor(cursor: string): Promise<void>;
  /** Record the snapshot obligation durably. Called at most once per run. */
  markSnapshotPending(): Promise<void>;
  /**
   * Re-enumerate every selection and retire whatever is unreachable. Resolves
   * false when the enumeration was incomplete, in which case the unseen-source
   * sweep did not run and the obligation is NOT discharged.
   */
  runSelectionSnapshot(): Promise<boolean>;
  /** Clear the durable obligation. Only ever called after a complete snapshot. */
  clearSnapshotPending(): Promise<void>;
}

export type ResumeSnapshotDeps = Pick<
  ReconcileChangesDeps<never>,
  "runSelectionSnapshot" | "clearSnapshotPending"
>;

/**
 * Discharge a snapshot obligation left behind by an earlier run, before any
 * new change page is consumed. The flag is cleared only once the snapshot has
 * completed, so a repeated failure repeats the snapshot rather than silently
 * dropping the obligation.
 */
export async function resumePendingSelectionSnapshot(
  deps: ResumeSnapshotDeps,
): Promise<boolean> {
  const complete = await deps.runSelectionSnapshot();
  if (complete) await deps.clearSnapshotPending();
  return complete;
}

/**
 * Consume the changes feed from `initialCursor` and return the cursor to
 * persist as the run's result.
 *
 * Ordering rules, in the order they matter:
 *  1. A snapshot obligation is written BEFORE the cursor moves past the page
 *     that raised it. A crash between the two can only replay work, never
 *     lose the obligation.
 *  2. The cursor is persisted after every page, unconditionally.
 *  3. The snapshot runs after the feed is drained, and the flag is cleared
 *     only when it succeeded.
 */
export async function reconcileChangePages<TChange>(
  initialCursor: string,
  deps: ReconcileChangesDeps<TChange>,
): Promise<string> {
  let cursor = initialCursor;
  let requiresSelectionSnapshot = false;
  for (;;) {
    const page = await deps.listChanges(cursor);
    for (const change of page.values) {
      const demandsSnapshot = await deps.processChange(change);
      if (demandsSnapshot && !requiresSelectionSnapshot) {
        requiresSelectionSnapshot = true;
        // Rule 1: durable before the cursor moves past this page.
        await deps.markSnapshotPending();
      }
    }
    cursor = page.nextPageToken ?? page.newStartPageToken ?? cursor;
    await deps.persistCursor(cursor);
    if (!page.nextPageToken) break;
  }
  if (requiresSelectionSnapshot) {
    await resumePendingSelectionSnapshot(deps);
  }
  return cursor;
}
