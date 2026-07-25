/**
 * Pure retention policy for the Nexus conversation sweep (Issue #1330).
 *
 * Everything in this module is side-effect free so the two invariants that
 * make an irreversible hard delete safe — "disabled means disabled" and "the
 * eligibility predicate is exactly what we say it is" — are unit-testable
 * without a database. See retention-policy.test.ts.
 */

/** Outcome of interpreting the NEXUS_CONVERSATION_RETENTION_DAYS setting. */
export type RetentionConfig =
  | { enabled: false; reason: DisabledReason }
  | { enabled: true; retentionDays: number };

export type DisabledReason =
  | "missing"
  | "empty"
  | "zero"
  | "negative"
  | "not_a_number"
  | "too_large";

/**
 * Upper bound on the retention window: 100 years.
 *
 * Not arbitrary politeness — values above this are not executable. The window
 * is bound as `$1::int`, so anything past 2147483647 fails the cast outright,
 * and `retentionCutoff()` on a large value produces an Invalid Date whose
 * .toISOString() throws, turning the nightly sweep into a hard error instead of
 * the no-op an operator would expect from a bad setting. Anything at or beyond
 * this bound is functionally "retention off" anyway, so it fails closed like
 * every other unusable value.
 */
export const MAX_RETENTION_DAYS = 36_500;

/**
 * Interpret the admin-configured retention window.
 *
 * The feature ships disabled and MUST fail closed: anything that is not an
 * unambiguous positive whole number of days disables the sweep. A misread
 * setting deleting user conversations is far worse than a sweep that no-ops,
 * so there is no default retention and no lenient coercion.
 */
export function parseRetentionDays(raw: string | null | undefined): RetentionConfig {
  if (raw === null || raw === undefined) {
    return { enabled: false, reason: "missing" };
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return { enabled: false, reason: "empty" };
  }

  // Number() accepts "0x10", "1e3", " 12 " and "Infinity"; a strict decimal
  // pattern keeps the admin field from ever meaning something surprising.
  if (!/^-?\d+$/.test(trimmed)) {
    return { enabled: false, reason: "not_a_number" };
  }

  const days = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(days)) {
    return { enabled: false, reason: "not_a_number" };
  }
  if (days === 0) {
    return { enabled: false, reason: "zero" };
  }
  if (days < 0) {
    return { enabled: false, reason: "negative" };
  }
  if (days > MAX_RETENTION_DAYS) {
    return { enabled: false, reason: "too_large" };
  }

  return { enabled: true, retentionDays: days };
}

/** A conversation row as far as the eligibility rule is concerned. */
export interface ConversationEligibilityRow {
  id: string;
  isSaved: boolean | null;
  isPinned: boolean | null;
  isArchived: boolean | null;
  /** UTC instant of the conversation's last persisted message. */
  lastMessageAt: Date | null;
}

/**
 * The eligibility predicate, stated once, in one place.
 *
 * A conversation is deleted only when ALL of:
 *   - it is not marked Keep (is_saved)
 *   - it is not pinned (pinning is an explicit user signal; hard delete is
 *     irreversible, so pinned rows are excluded conservatively)
 *   - its last message is strictly older than the retention cutoff
 *
 * Deliberately NOT part of the predicate: `is_archived`. Archiving is what the
 * Nexus "Delete" button does today and is not protection — archived-but-stale
 * conversations are eligible. Keep is the protection.
 *
 * NULL handling mirrors the SQL: a NULL is_saved/is_pinned counts as "not
 * flagged", and a NULL last_message_at is never eligible because there is no
 * inactivity clock to measure against.
 */
export function isEligibleForDeletion(
  row: ConversationEligibilityRow,
  cutoff: Date
): boolean {
  if (row.isSaved === true) return false;
  if (row.isPinned === true) return false;
  if (row.lastMessageAt === null || row.lastMessageAt === undefined) return false;
  return row.lastMessageAt.getTime() < cutoff.getTime();
}

/** Milliseconds in a day. */
const DAY_MS = 86_400_000;

/**
 * The instant a conversation's last message must precede to be eligible.
 * Exported so the sweep and its tests derive the cutoff the same way.
 */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

/**
 * SQL fragment (sans parameters) for the candidate scan, kept beside the
 * in-memory predicate so the two cannot drift apart unnoticed.
 *
 * `is_pinned IS NOT TRUE` rather than `is_pinned = false`: is_pinned is
 * nullable, and `NULL = false` is NULL, which would silently exempt every
 * NULL-pinned conversation from the sweep. It matches the partial index
 * predicate created by migration 137.
 *
 * The cutoff is compared against `now() AT TIME ZONE 'UTC'` because
 * last_message_at is `timestamp without time zone` holding UTC wall time;
 * a bare `now()` would be interpreted in the session time zone.
 */
export const CANDIDATE_WHERE_CLAUSE = `
  is_saved = false
  AND is_pinned IS NOT TRUE
  AND last_message_at IS NOT NULL
  AND last_message_at < (now() AT TIME ZONE 'UTC') - ($1::int * interval '1 day')
`.trim();

/**
 * Authoritative age check, derived from COMMITTED messages rather than the
 * denormalized `nexus_conversations.last_message_at` clock.
 *
 * `upsertMessageWithStats` (lib/db/drizzle/nexus-messages.ts) inserts the
 * message and updates the conversation's stats as two separate statements —
 * its own docstring says "Not atomic - stats may be briefly out of sync if
 * update fails". So a resumed conversation can have a committed message while
 * `last_message_at` still reads stale, either transiently between the two
 * statements or permanently if the stats update failed. Gating an irreversible
 * delete on the denormalized column alone would destroy that message and the
 * conversation with it.
 *
 * Deliberately NOT part of CANDIDATE_WHERE_CLAUSE: the batch scan stays a cheap
 * indexed range read over `last_message_at`, and this per-row check runs only
 * in the authoritative gates (the late re-check and the claiming DELETE), where
 * `idx_nexus_messages_conversation (conversation_id, created_at)` makes it an
 * index lookup. Cheap scan, authoritative claim.
 *
 * Uses $1 (the retention window) so it composes with CANDIDATE_WHERE_CLAUSE.
 */
export const NO_COMMITTED_MESSAGE_INSIDE_WINDOW_SQL = `
  NOT EXISTS (
    SELECT 1
    FROM nexus_messages m
    WHERE m.conversation_id = nexus_conversations.id
      AND m.created_at >= (now() AT TIME ZONE 'UTC') - ($1::int * interval '1 day')
  )
`.trim();
