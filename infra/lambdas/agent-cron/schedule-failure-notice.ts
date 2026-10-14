/**
 * Tell the schedule's owner when their standing job keeps failing (#1890).
 *
 * Until this existed, run status was visible only to the agent through
 * `psd-schedules runs` and to admins on `/admin/agents`. In a read of 375
 * staff members' agent use (Aug–Oct 2026) about 30 people had a standing job
 * failing without knowing; one teacher's daily recap failed every weekday for
 * over a month on an expired Google authorization before anyone noticed.
 *
 * ONE message per failure streak, and the suppression is a RECORDED FACT: the
 * run that carried the message is stamped `owner_notified_at` (migration 188)
 * and the rule stays quiet while any run in the current streak carries that
 * stamp. A success ends the streak, so the next three failures speak again.
 *
 * It is deliberately not inferred from the streak's length. Length says "this
 * streak reached three", not "somebody was told", and the two come apart in
 * both directions that matter:
 *
 *   - a schedule already failing when this shipped has a streak far longer
 *     than three on its very next run, so a length rule reads it as already
 *     handled and never messages the owner — skipping exactly the people
 *     #1890 was opened for;
 *   - if the message itself fails to send, a length rule still counts that run
 *     as the one that spoke, and the schedule goes quiet until it succeeds.
 *
 * With the stamp, both become retries on the next failing run instead.
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

export interface ScheduleFailureNoticeQuery {
  /**
   * The schedule's recent streak-deciding runs, newest first, as
   * `readRecentRunStatuses` returns them — `skipped` and `promoted` already
   * excluded, and the run the caller just recorded at index 0.
   */
  rows: readonly ScheduleRunStatusRow[];
  /**
   * The error text of the run just recorded, UNTRUNCATED.
   *
   * The stored copy is capped at 500 characters, and a failure whose prose
   * runs long can have the authorization signature cut off the end — which
   * would downgrade a revoked grant from "speak now" to "wait for three
   * failures", costing the owner days. Classification reads the full text;
   * only the DB and the message body use the capped one.
   */
  currentErrorMessage?: string | null;
}

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
  query: ScheduleFailureNoticeQuery,
): ScheduleFailureNoticeDecision {
  const streak = currentFailureStreak(query.rows);
  // No current streak means the newest streak-deciding run was a success, or
  // the caller's own row never landed. Either way there is nothing to report,
  // and staying quiet is the only reading that cannot invent a message.
  if (streak.length === 0) return { notify: false };

  // Somebody in this streak already carried the message.
  if (streak.some((row) => row.ownerNotified)) return { notify: false };

  // A revoked grant speaks on the FIRST failure: nothing will fix itself
  // without the owner, and waiting for three runs costs a teacher three days.
  // Classified from the untruncated text when the caller has it.
  const currentError = query.currentErrorMessage ?? streak[0].errorMessage;
  if (
    isWorkspaceAuthFailure(currentError)
    || isWorkspaceAuthFailure(streak[0].errorMessage)
  ) {
    return {
      notify: true,
      reason: 'auth',
      consecutiveFailures: streak.length,
    };
  }

  // At or above the threshold, not exactly at it: a streak that was already
  // long before this rule existed, or whose earlier message failed to send,
  // still has an owner who has heard nothing.
  return streak.length >= NOTICE_THRESHOLD
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
  // Single-asterisk bold. Google Chat renders `*bold*`; `**bold**` arrives as
  // literal asterisks (see infra/agent-image/chat_format.py, which converts
  // the model's Markdown for exactly this reason). This text is composed here
  // and never passes through that converter, so it has to be Chat's dialect
  // already — otherwise the one thing meant to catch a teacher's eye is noise.
  const headline =
    input.reason === 'auth'
      ? `⚠️ *${input.scheduleName}* could not run: my access to your Google account has expired or been turned off.`
      : `⚠️ *${input.scheduleName}* has now failed ${input.consecutiveFailures} times in a row, so you have not been getting it.`;
  const reasonLine =
    input.reason === 'auth'
      ? 'Nothing is wrong with the schedule itself — it just cannot reach your mail, calendar, or files until the connection is renewed.'
      : `Last reason: ${plainReason(input.errorMessage)}`;
  const fix =
    input.reason === 'auth'
      ? input.consentUrl
        ? `*Fix it:* <${input.consentUrl}|Reconnect Google Workspace>. The schedule starts working again on its next run.`
        : '*Fix it:* reply here and ask me to reconnect your Google Workspace account — I will send you a fresh authorization link.'
      : '*Fix it:* reply here and ask your agent to check this schedule.';
  return [headline, reasonLine, fix].join('\n\n');
}
