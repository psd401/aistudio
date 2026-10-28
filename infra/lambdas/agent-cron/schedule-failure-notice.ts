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
 * stamp — aggregated in SQL over the streak's newest 500 runs, never over a
 * small page of recent rows, because a stamp that scrolls off the page reads as
 * "nobody was told" and the owner gets a second message, then a third. The
 * 500-run bound is the one deliberate exception: a streak longer than that
 * loses sight of its own stamp and the owner is reminded once more (see
 * `FAILURE_STREAK_RUN_LIMIT` in `run-telemetry.ts`). A success ends the
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

import {
  FAILURE_STREAK_RUN_LIMIT,
  type ScheduleFailureStreak,
} from './run-telemetry';

/** Consecutive non-success runs that earn one owner DM. */
export const NOTICE_THRESHOLD = 3;

/**
 * Signatures that can ONLY come from the Google Workspace path: Google's own
 * `invalid_grant`, the psd-workspace skill's `token-revoked` status, and the
 * Workspace broker's prose (`app/api/agent/workspace-execute/route.ts`).
 */
const WORKSPACE_AUTH_PATTERNS: readonly RegExp[] = [
  /invalid_grant/i,
  /token[-_ ]revoked/i,
  /workspace (?:authorization|access) (?:is required|was revoked)/i,
];

/**
 * Auth signatures every integration shares. Canva, Plaud, PSD Data, and AI
 * Studio skills all emit `needs-auth` too, and the auth notice's fix is a
 * Google Workspace consent link — so on these alone the notice would tell a
 * Canva user their mail and calendar access expired and hand them the wrong
 * link. They count only when the same text names Google or Workspace.
 */
const GENERIC_AUTH_PATTERNS: readonly RegExp[] = [
  /needs[-_ ]auth/i,
  /authorization (?:has )?expired/i,
  /re-?authorize/i,
];
const WORKSPACE_CONTEXT = /\b(?:google|workspace|gmail|psd-workspace)\b/i;

export function isWorkspaceAuthFailure(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (WORKSPACE_AUTH_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return (
    GENERIC_AUTH_PATTERNS.some((pattern) => pattern.test(text))
    && WORKSPACE_CONTEXT.test(text)
  );
}

/**
 * The owner's PSD Public Records (PRR) personal access token is missing,
 * expired (PRR tokens last at most 90 days), or revoked. Matched ONLY on the
 * psd-prr skill's own codes, never on prose that mentions PRR, because the
 * fix is a credential-entry link for the `prr_pat` slot.
 */
const PRR_CREDENTIAL_PATTERN = /prr_token_(?:missing|rejected)/i;

export function isPrrCredentialFailure(text: string | null | undefined): boolean {
  return typeof text === 'string' && PRR_CREDENTIAL_PATTERN.test(text);
}

/**
 * `auth` is a Google Workspace re-consent; `prr-credential` is a new PRR
 * personal access token; `streak` is everything else.
 */
export type ScheduleFailureNoticeReason = 'auth' | 'prr-credential' | 'streak';

export type ScheduleFailureNoticeDecision =
  | { notify: false }
  | {
      notify: true;
      reason: ScheduleFailureNoticeReason;
      consecutiveFailures: number;
    };

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

  // A PRR token failure also cannot fix itself, so it speaks on the first
  // failure too. Checked after Google: a run that lost both is fixed in the
  // order the owner is most likely to need first, and the next run reports
  // the other.
  if (
    isPrrCredentialFailure(query.currentErrorMessage)
    || isPrrCredentialFailure(newestErrorMessage)
  ) {
    return { notify: true, reason: 'prr-credential', consecutiveFailures };
  }

  // At or above the threshold, not exactly at it: a streak that was already
  // long before this rule existed, or whose earlier message failed to send,
  // still has an owner who has heard nothing.
  return consecutiveFailures >= NOTICE_THRESHOLD
    ? { notify: true, reason: 'streak', consecutiveFailures }
    : { notify: false };
}

/**
 * How the streak reads to a human.
 *
 * The count is measured over a bounded number of this schedule's runs, so a
 * streak at that bound is a floor rather than a total. Saying "500 runs" when
 * it is really 700 would be a number the owner could check and find wrong.
 */
function describeStreak(consecutiveFailures: number): string {
  return consecutiveFailures >= FAILURE_STREAK_RUN_LIMIT
    ? `at least ${consecutiveFailures} runs`
    : `${consecutiveFailures} runs`;
}

export interface ScheduleFailureNoticeInput {
  scheduleName: string;
  reason: ScheduleFailureNoticeReason;
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
  if (input.reason === 'prr-credential') {
    return [
      `⚠️ *${input.scheduleName}* could not reach PSD Public Records: your PRR personal access token is missing, expired, or revoked.`,
      'Create a new token at https://prr.psd401.net/agent-access (tokens last at most 90 days).',
      input.consentUrl
        ? `*Fix it:* <${input.consentUrl}|Save your new PRR token> — paste the token there, not in this chat. The link works once and expires in 15 minutes; if it has expired, reply here and ask me for a PRR token link.`
        : '*Fix it:* reply here and ask me for a PRR token link, then paste the new token into that page — not into this chat.',
    ].join('\n\n');
  }
  const headline =
    input.reason === 'auth'
      ? `⚠️ *${input.scheduleName}* could not run: my access to your Google account has expired or been turned off.`
      // "has not reached you", not "has failed": a streak can be made of runs
      // whose Chat post is still on the retry queue (`deferred`), which may
      // yet land. Either way the owner has nothing in hand, and that is the
      // part they can act on.
      : `⚠️ *${input.scheduleName}* has not reached you for ${describeStreak(input.consecutiveFailures)} in a row.`;
  const reasonLine =
    input.reason === 'auth'
      ? 'Nothing is wrong with the schedule itself — it just cannot reach your mail, calendar, or files until the connection is renewed.'
      : `Last reason: ${plainReason(input.errorMessage)}`;
  const fix =
    input.reason === 'auth'
      ? input.consentUrl
        // Deliberately promises nothing about a next run: an `at(...)`
        // one-shot has none, and telling its owner the schedule will work
        // again would be false.
        ? `*Fix it:* <${input.consentUrl}|Reconnect Google Workspace>.`
        : '*Fix it:* reply here and ask me to reconnect your Google Workspace account — I will send you a fresh authorization link.'
      : '*Fix it:* reply here and ask your agent to check this schedule.';
  return [headline, reasonLine, fix].join('\n\n');
}
