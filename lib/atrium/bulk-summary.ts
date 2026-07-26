/**
 * Aggregated reporting for the library's bulk-action fan-out (#1336).
 *
 * Pure formatting, deliberately kept out of `LibraryBulkBar` so it can be unit
 * tested without dragging the component's server-action imports (and their ESM
 * dependency chain) into the test environment.
 *
 * Partial failure is the NORMAL case for a bulk action — deleting a mixed
 * selection refuses published objects with a 409 while drafts succeed — so this
 * sentence is the entire user-facing report and has to read correctly in all
 * three branches.
 */

/** The outcome of one bulk fan-out. */
export interface BulkOutcome {
  succeeded: number;
  /** One entry per distinct failure message, with how many ids hit it. */
  failures: Map<string, number>;
}

/**
 * `verb` is the PAST-tense outcome word ("Archived", "Deleted") because two of
 * the three branches report what happened. The all-failed branch needs the
 * INFINITIVE instead ("Could not archive…"), so it maps rather than
 * lowercasing — `Could not archived 2 items` was the previous, ungrammatical
 * output.
 */
const INFINITIVE_OF: Record<string, string> = {
  Archived: "archive",
  Restored: "restore",
  Moved: "move",
  Deleted: "delete",
};

/** Render one aggregated sentence from a fan-out outcome. */
export function summarize(
  outcome: BulkOutcome,
  verb: string,
  total: number
): string {
  const { succeeded, failures } = outcome;
  if (failures.size === 0) {
    return `${verb} ${succeeded} ${succeeded === 1 ? "item" : "items"}.`;
  }
  const failed = total - succeeded;
  const reasons = [...failures.entries()]
    .map(([message, count]) => (count > 1 ? `${message} (×${count})` : message))
    .join("; ");
  if (succeeded === 0) {
    // `?? verb.toLowerCase()` keeps an unmapped future verb readable rather
    // than printing "undefined".
    const infinitive = INFINITIVE_OF[verb] ?? verb.toLowerCase();
    return `Could not ${infinitive} ${failed} ${
      failed === 1 ? "item" : "items"
    }: ${reasons}`;
  }
  return `${verb} ${succeeded} of ${total}. ${failed} failed: ${reasons}`;
}
