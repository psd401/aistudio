/**
 * Initial-inbox sweep (#1172, #996 item 2).
 *
 * When a user enables triage — or runs the `sweep` skill subcommand — we
 * backfill their existing INBOX (last 30 days, capped at 1000 messages)
 * through the SAME rules→LLM pipeline as live triage, with two twists:
 *
 *   - ESCALATION IS SUPPRESSED. A bulk backfill must never ping-storm the
 *     user's Chat, so classifyAndLabel is called with suppressEscalation.
 *   - It is RESUMABLE. State (Gmail page cursor + processed/labeled counts)
 *     lives on the DDB row's `sweep` map. Each call runs exactly ONE page
 *     (page boundaries are the only safe resume points — a partially
 *     processed page would drop its unprocessed ids) and re-enqueues a
 *     continuation until the page cursor is exhausted or the cap is hit.
 *
 * Pure orchestration over gmail.ts + storage.ts + index.ts's
 * classifyAndLabel; the worker (worker.ts) drives it and handles the
 * SQS re-enqueue.
 */

import { acquireUserAccessToken, classifyAndLabel, log } from "./index";
import { listInboxMessages } from "./gmail";
import { recordSweepSlice } from "./storage";
import type { DecisionRecord, SweepState, TriageRow } from "./types";

/**
 * Injectable dependencies — defaults are the real AWS/Gmail helpers; unit
 * tests pass stubs so runSweepSlice's pagination/cap/resume state machine
 * is testable without AWS or global module mocks.
 */
export interface SweepDeps {
  acquireAccessToken: (userEmail: string) => Promise<string | null>;
  listInboxMessages: typeof listInboxMessages;
  classifyAndLabel: typeof classifyAndLabel;
  recordSweepSlice: typeof recordSweepSlice;
}

const defaultDeps: SweepDeps = {
  acquireAccessToken: acquireUserAccessToken,
  listInboxMessages,
  classifyAndLabel,
  recordSweepSlice,
};

/** Newest-N-days window the sweep considers. */
export const SWEEP_WINDOW_DAYS = 30;

/** Hard cap on messages a sweep will examine. */
export const SWEEP_CAP = 1000;

/**
 * Messages fetched + classified per slice. One page per slice keeps each
 * worker invocation well under the Lambda timeout AND makes the page
 * cursor a safe resume point. 50 (not Gmail's 100 max) leaves headroom for
 * the per-message LLM calls.
 */
export const SWEEP_PAGE_SIZE = 50;

export interface SweepSliceOutcome {
  sweep: SweepState;
  /** True when the worker should re-enqueue another sweep continuation. */
  shouldContinue: boolean;
}

/** Seed a fresh sweep state (used on enable + the `sweep` subcommand). */
export function newSweepState(now = new Date().toISOString()): SweepState {
  return {
    status: "pending",
    pageToken: null,
    processed: 0,
    labeled: 0,
    windowDays: SWEEP_WINDOW_DAYS,
    cap: SWEEP_CAP,
    startedAt: now,
    updatedAt: now,
  };
}

/**
 * Run ONE page of a user's initial-inbox sweep. Reads the current sweep
 * state off `row`, processes the next page, persists the updated state +
 * any decisions, and reports whether a continuation is needed.
 */
export async function runSweepSlice(
  row: TriageRow,
  deps: SweepDeps = defaultDeps,
): Promise<SweepSliceOutcome> {
  const t0 = Date.now();
  const prior: SweepState = row.sweep ?? newSweepState();
  const cap = prior.cap ?? SWEEP_CAP;
  const windowDays = prior.windowDays ?? SWEEP_WINDOW_DAYS;

  // Already finished — idempotent no-op (a late/duplicate SQS message).
  if (prior.status === "complete" || prior.status === "error") {
    return { sweep: prior, shouldContinue: false };
  }

  const accessToken = await deps.acquireAccessToken(row.userEmail);
  if (!accessToken) {
    // No token (revoked / not consented). Stop the sweep rather than
    // re-enqueue forever; the user can re-run `sweep` after re-consenting.
    const sweep: SweepState = {
      ...prior,
      status: "error",
      error: "no-access-token",
      updatedAt: new Date().toISOString(),
    };
    await deps.recordSweepSlice(row.userEmail, [], sweep);
    log("WARN", "sweep_no_token", { user: row.userEmail });
    return { sweep, shouldContinue: false };
  }

  let processed = prior.processed ?? 0;
  let labeled = prior.labeled ?? 0;
  const decisions: DecisionRecord[] = [];

  // status + nextPageToken are assigned in every try branch AND the catch,
  // so no initializer is needed (and a dead one trips CodeQL).
  let status: SweepState["status"];
  let nextPageToken: string | null | undefined;
  let shouldContinue = false;
  let errorMsg: string | undefined;

  try {
    const { messages, nextPageToken: np } = await deps.listInboxMessages(accessToken, {
      query: `in:inbox newer_than:${windowDays}d`,
      pageToken: prior.pageToken ?? undefined,
      maxResults: SWEEP_PAGE_SIZE,
    });

    // Respect the cap: only take what remains of the 1000-message budget.
    const remaining = Math.max(0, cap - processed);
    const toProcess = messages.slice(0, remaining);

    for (const m of toProcess) {
      processed++;
      try {
        const r = await deps.classifyAndLabel(
          row,
          accessToken,
          { id: m.id, threadId: m.threadId },
          { suppressEscalation: true },
        );
        if (r) labeled++;
        if (r) decisions.push(r.decision);
      } catch (err) {
        log("ERROR", "sweep_classify_failed", {
          user: row.userEmail,
          messageId: m.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (processed >= cap) {
      status = "complete";
      nextPageToken = null;
    } else if (!np) {
      // No more pages — the inbox window is exhausted.
      status = "complete";
      nextPageToken = null;
    } else {
      status = "running";
      nextPageToken = np;
      shouldContinue = true;
    }
  } catch (err) {
    status = "error";
    errorMsg = err instanceof Error ? err.message : String(err);
    nextPageToken = prior.pageToken ?? null;
    shouldContinue = false;
    log("ERROR", "sweep_page_failed", {
      user: row.userEmail,
      err: errorMsg,
    });
  }

  const sweep: SweepState = {
    status,
    pageToken: nextPageToken ?? null,
    processed,
    labeled,
    windowDays,
    cap,
    startedAt: prior.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(errorMsg ? { error: errorMsg } : {}),
  };

  await deps.recordSweepSlice(row.userEmail, decisions, sweep);

  log("INFO", "sweep_slice", {
    user: row.userEmail,
    status,
    processed,
    labeled,
    slice_labeled: decisions.length,
    should_continue: shouldContinue,
    elapsed_ms: Date.now() - t0,
  });

  return { sweep, shouldContinue };
}
