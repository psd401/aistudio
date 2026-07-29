/**
 * Turn-deadline arithmetic for scheduled tasks — pure, dependency-free.
 *
 * Split out from index.ts for the same reason as the router's job-promotion.ts:
 * so it can be unit tested without the Lambda runtime or the AWS SDK. That
 * matters more than usual here, because jest runs NO tests under
 * infra/lambdas — a test placed beside this file would never execute. The
 * suite lives in tests/unit/agent-cron-turn-deadline.test.ts.
 *
 * THE BUG THIS EXISTS TO PREVENT
 *
 * Three clocks bound a scheduled turn, and they must fire in this order:
 *
 *   harness turn deadline  <  our fetch abort  <  Lambda timeout (900s, an AWS
 *                                                 hard ceiling we cannot raise)
 *
 * Each gap gives the next layer out time to do its job: the harness stops work
 * and returns a PARTIAL answer, we post that answer to Chat, and Lambda lets us
 * finish.
 *
 * The ordering used to be hardcoded — a fixed 870s abort against the harness's
 * fixed 840s default — which quietly assumed the turn begins the instant we
 * send the request. It does not. AgentCore has to cold-start a microVM, route
 * the session, and open the SSE stream first, and the harness deadline only
 * starts counting once the turn is actually running in the container.
 *
 * On 2026-07-27 that gap was ~47s. A Morning Dispatch ran 824s of turn time —
 * comfortably inside the harness's 840s — but 824s + 47s exceeded our 870s
 * abort, so we hung up 5.6 seconds before the agent finished. The harness never
 * reached its own deadline, so it never produced the partial the design
 * intended, and the owner got "Agent temporarily unavailable" after 14.5
 * minutes of work that had actually succeeded.
 *
 * Deriving every bound from the Lambda's real remaining time keeps the ordering
 * true no matter how slow the cold start is.
 */

/**
 * Reserve for posting the reply (or the failure frame) to Google Chat after the
 * agent returns. Everything after the abort has to fit in here.
 */
export const REPLY_RESERVE_MS = 30_000;

/**
 * Allowance for the gap between "we send the request" and "the turn starts
 * running in the container": microVM cold start, session routing, SSE setup.
 *
 * Deliberately generous. Over-reserving costs the agent a little turn time;
 * under-reserving throws away the entire turn, including work already done.
 */
export const STARTUP_RESERVE_S = 90;

/** Time for the harness to stop work, assemble a partial, and stream it back. */
export const HARNESS_LEAD_S = 20;

/**
 * Clamp applied by the harness itself for a non-job turn
 * (agent-image/harness_adapter.py `_resolve_deadline_s`). Sending a value
 * outside this range is pointless: the harness silently clamps it, and a
 * garbage value degrades to its 840s default rather than raising.
 */
export const HARNESS_DEADLINE_MIN_S = 60;
export const HARNESS_DEADLINE_MAX_S = 840;

/**
 * Deadline to hand the agent, in seconds, derived from the Lambda's real
 * remaining time so every bound comes from ONE clock.
 */
export function resolveTurnDeadlineS(remainingMs: number): number {
  const abortBudgetS = Math.floor((remainingMs - REPLY_RESERVE_MS) / 1000);
  const usable = abortBudgetS - STARTUP_RESERVE_S - HARNESS_LEAD_S;
  return Math.min(
    HARNESS_DEADLINE_MAX_S,
    Math.max(HARNESS_DEADLINE_MIN_S, usable),
  );
}

/**
 * Milliseconds to allow the fetch before aborting. Always leaves REPLY_RESERVE
 * so a timeout can still be reported to the user, and never returns a
 * non-positive timeout (which would abort instantly).
 */
export function resolveAbortMs(remainingMs: number): number {
  return Math.max(1000, remainingMs - REPLY_RESERVE_MS);
}
