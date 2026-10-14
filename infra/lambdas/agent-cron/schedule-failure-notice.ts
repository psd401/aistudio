/**
 * Tell the schedule's owner when their standing job keeps failing (#1890).
 *
 * Until this existed, run status was visible only to the agent through
 * `psd-schedules runs` and to admins on `/admin/agents`. In a read of 375
 * staff members' agent use (Aug–Oct 2026) about 30 people had a standing job
 * failing without knowing; one teacher's daily recap failed every weekday for
 * over a month on an expired Google authorization before anyone noticed.
 *
 * The suppression state is the run history itself. There is no separate
 * "already notified" store to drift out of sync with the rows: the notice
 * fires on the run that makes the streak exactly `NOTICE_THRESHOLD` long, and
 * on the FIRST authorization failure of a streak. A longer streak is silent,
 * and a success resets the streak so the next three failures speak again.
 */

import type { ScheduleRunStatusRow } from './run-telemetry';

/** Consecutive non-success runs that earn one owner DM. */
export const NOTICE_THRESHOLD = 3;

/**
 * Statuses that count as a failed run.
 *
 * `skipped` (a coalesced fire) and `promoted` (handed to the background
 * job-runner, whose own row is updated when it finishes) are neither failures
 * nor successes — they are ignored, so a coalesced fire cannot break a real
 * failure streak and an in-flight promotion cannot start a false one.
 */
const FAILED_STATUSES = new Set(['error', 'deferred']);

/**
 * Signatures of an expired or revoked Google Workspace grant.
 *
 * Google's own `invalid_grant` plus the statuses the psd-workspace skill emits
 * on that path (`token-revoked`, `needs-auth`) and the prose the broker
 * returns. Matched case-insensitively against the run's recorded error text.
 */
const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /invalid_grant/i,
  /token[-_ ]revoked/i,
  /needs[-_ ]auth/i,
  /workspace authorization (?:is required|was revoked)/i,
  /authorization (?:has )?expired/i,
  /re-?authorize/i,
];

export function isWorkspaceAuthFailure(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export type ScheduleFailureNoticeDecision =
  | { notify: false }
  | { notify: true; reason: 'auth' | 'streak'; consecutiveFailures: number };

/**
 * The current failure streak: the failed runs since the last success, newest
 * first. Rows after (older than) the most recent `success` are not part of it.
 */
export function currentFailureStreak(
  rows: readonly ScheduleRunStatusRow[],
): ScheduleRunStatusRow[] {
  const streak: ScheduleRunStatusRow[] = [];
  for (const row of rows) {
    if (row.status === 'success') break;
    if (FAILED_STATUSES.has(row.status)) streak.push(row);
  }
  return streak;
}

/**
 * Decide whether THIS run earns an owner DM.
 *
 * `rows` is the schedule's recent history, newest first, with the run just
 * recorded at index 0.
 */
export function decideScheduleFailureNotice(
  rows: readonly ScheduleRunStatusRow[],
): ScheduleFailureNoticeDecision {
  const streak = currentFailureStreak(rows);
  // The newest row is not a failure (success, skipped, or still promoted), so
  // there is nothing new to report.
  if (streak.length === 0 || streak[0] !== rows[0]) return { notify: false };

  // ONE DM per streak, whatever the reason: "not repeated until the schedule
  // succeeds again" is a property of the schedule, not of the cause. Rather
  // than storing a flag that can drift from the rows, re-derive it — an
  // earlier run in this streak already spoke if it was an authorization
  // failure (which speaks on sight) or if the streak behind this run already
  // reached the threshold.
  const earlier = streak.slice(1);
  const alreadyNotified =
    earlier.some((row) => isWorkspaceAuthFailure(row.errorMessage))
    || earlier.length >= NOTICE_THRESHOLD;
  if (alreadyNotified) return { notify: false };

  // A revoked grant speaks on the first failure: nothing will fix itself, and
  // waiting for three runs costs a teacher three days of silence.
  if (isWorkspaceAuthFailure(streak[0].errorMessage)) {
    return {
      notify: true,
      reason: 'auth',
      consecutiveFailures: streak.length,
    };
  }

  // Exactly at the threshold, never at or above it: the equality IS the
  // suppression. A fourth, fifth, or hundredth consecutive failure adds
  // nothing the third one did not already say.
  return streak.length === NOTICE_THRESHOLD
    ? { notify: true, reason: 'streak', consecutiveFailures: streak.length }
    : { notify: false };
}

export interface ScheduleFailureNoticeInput {
  scheduleName: string;
  reason: 'auth' | 'streak';
  consecutiveFailures: number;
  /** The run's recorded error, already sanitized and length-bounded. */
  errorMessage: string | null;
  /** A freshly minted consent URL, when one could be issued. */
  consentUrl?: string | null;
}

const REASON_MAX_LENGTH = 300;

function plainReason(errorMessage: string | null): string {
  if (!errorMessage) return 'The run ended without a usable result.';
  return errorMessage.length > REASON_MAX_LENGTH
    ? `${errorMessage.slice(0, REASON_MAX_LENGTH)}…`
    : errorMessage;
}

/**
 * The DM text. Names the schedule, gives the reason in plain words, and ends
 * with the one action that fixes it — a consent link for an authorization
 * failure, otherwise the sentence that gets the agent to investigate.
 */
export function buildScheduleFailureNoticeText(
  input: ScheduleFailureNoticeInput,
): string {
  const headline =
    input.reason === 'auth'
      ? `⚠️ **${input.scheduleName}** could not run: my access to your Google account has expired or been turned off.`
      : `⚠️ **${input.scheduleName}** has now failed ${input.consecutiveFailures} times in a row, so you have not been getting it.`;
  const reasonLine =
    input.reason === 'auth'
      ? 'Nothing is wrong with the schedule itself — it just cannot reach your mail, calendar, or files until the connection is renewed.'
      : `Last reason: ${plainReason(input.errorMessage)}`;
  const fix =
    input.reason === 'auth'
      ? input.consentUrl
        ? `**Fix it:** <${input.consentUrl}|Reconnect Google Workspace>. The schedule starts working again on its next run.`
        : '**Fix it:** reply here and ask me to reconnect your Google Workspace account — I will send you a fresh authorization link.'
      : '**Fix it:** reply here and ask your agent to check this schedule.';
  return [headline, reasonLine, fix].join('\n\n');
}
