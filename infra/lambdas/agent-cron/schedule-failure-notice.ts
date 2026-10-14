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
 * run that carried the message is stamped `owner_notified_at` (migration 188),
 * and the rule stays quiet while ANY run in the current streak carries that
 * stamp — evaluated over the whole streak in SQL, never over a page of recent
 * runs, because a stamp that scrolls off the page reads as "nobody was told"
 * and the owner gets a second message, then a third. A success ends the
 * streak, so the next three failures speak again.
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

import type { ScheduleFailureStreak } from './run-telemetry';

/** Consecutive non-success runs that earn one owner DM. */
export const NOTICE_THRESHOLD = 3;

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
  /** The schedule's current failure streak, aggregated over the whole streak. */
  streak: ScheduleFailureStreak;
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
 * Decide whether the run just recorded earns an owner DM.
 *
 * Called only right after a failed run has been written, so the streak below
 * already includes it.
 */
export function decideScheduleFailureNotice(
  query: ScheduleFailureNoticeQuery,
): ScheduleFailureNoticeDecision {
  const { consecutiveFailures, alreadyNotified, newestErrorMessage } =
    query.streak;

  // No current streak means the newest streak-deciding run was a success, or
  // the caller's own row never landed. Either way there is nothing to report,
  // and staying quiet is the only reading that cannot invent a message.
  if (consecutiveFailures === 0) return { notify: false };

  // Somebody in this streak already carried the message.
  if (alreadyNotified) return { notify: false };

  // A revoked grant speaks on the FIRST failure: nothing will fix itself
  // without the owner, and waiting for three runs costs a teacher three days.
  // Classified from the untruncated text when the caller has it.
  if (
    isWorkspaceAuthFailure(query.currentErrorMessage)
    || isWorkspaceAuthFailure(newestErrorMessage)
  ) {
    return { notify: true, reason: 'auth', consecutiveFailures };
  }

  // At or above the threshold, not exactly at it: a streak that was already
  // long before this rule existed, or whose earlier message failed to send,
  // still has an owner who has heard nothing.
  return consecutiveFailures >= NOTICE_THRESHOLD
    ? { notify: true, reason: 'streak', consecutiveFailures }
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
