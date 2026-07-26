/**
 * Atrium bulk fan-out runner (#1336).
 *
 * Pure helper extracted from `LibraryBulkBar` so the fan-out semantics are
 * unit-testable: bounded concurrency, never rejects, and reports WHICH ids
 * succeeded — the only ids a caller may safely drop from a live selection.
 * (Dropping the whole selection after a bulk action silently discarded picks
 * the user made while the fan-out was in flight.)
 */

import type { BulkOutcome } from "./bulk-summary";

/**
 * Max in-flight server actions during a fan-out. Bounded so selecting a full
 * 50-row page cannot open 50 simultaneous requests (each of which takes a DB
 * connection from the pool).
 */
export const BULK_CONCURRENCY = 4;

export interface BulkRunResult {
  outcome: BulkOutcome;
  /**
   * Ids whose task reported success, in completion order. Failed ids are
   * deliberately NOT included: they stay selected so the user can retry or
   * narrow the selection.
   */
  succeededIds: string[];
}

/**
 * Run `task` over `ids` with bounded concurrency, collecting per-id outcomes.
 * Never rejects: a thrown task is recorded as a failure like any other (and
 * surfaced to `onTaskError` for logging), so one network error cannot abandon
 * the rest of the selection.
 */
export async function runBounded(
  ids: string[],
  task: (id: string) => Promise<{ isSuccess: boolean; message?: string }>,
  onTaskError?: (id: string, error: unknown) => void
): Promise<BulkRunResult> {
  const outcome: BulkOutcome = { succeeded: 0, failures: new Map() };
  const succeededIds: string[] = [];
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
        if (res.isSuccess) {
          outcome.succeeded += 1;
          succeededIds.push(id);
        } else {
          recordFailure(res.message ?? "Refused by the server");
        }
      } catch (e) {
        onTaskError?.(id, e);
        recordFailure("Request failed — please try again");
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(BULK_CONCURRENCY, ids.length) }, worker)
  );
  return { outcome, succeededIds };
}
