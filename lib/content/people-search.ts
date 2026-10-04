/**
 * Atrium people lookup (#1860) — resolve a person to the `users.id` a `user`
 * visibility grant stores.
 *
 * A `user` grant value is a numeric `users.id` and NEVER an email
 * (`visibility-service.assertValidGrant`), so anything that wants to share an
 * object with a named person must first turn "Jane Doe" or "jdoe@psd401.net"
 * into that id. Two surfaces need the same answer:
 *
 *   - the web visibility editor's people picker
 *     (`actions/db/atrium/search-people.ts` → `components/atrium/PeoplePicker.tsx`)
 *   - the owner-bound agent broker (`GET /_people` in
 *     `lib/agent-workspace/atrium-owner-operation.ts`, surfaced as
 *     `psd-atrium find-people`)
 *
 * The query lives here so those two cannot drift apart on the projection, the
 * result cap, or the minimum query length — the three things that keep this from
 * becoming a directory dump.
 *
 * This module does NOT authorize anything. Both callers gate on the
 * `atrium-content` authoring capability before calling it, because any author
 * building a grant needs it and this is not the admin user-management surface.
 */

import { asc, ilike, isNotNull, or, sql, and } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { escapeSearchPattern } from "@/lib/db/drizzle/helpers/search";
import { users } from "@/lib/db/schema";

/**
 * Shortest accepted query. Below this the search returns an empty list rather
 * than matching a large slice of the directory on one or two characters.
 */
export const PEOPLE_SEARCH_MIN_QUERY_LENGTH = 2;

/**
 * Longest accepted query. Exported so a caller that validates its input (the
 * agent broker's zod schema) rejects at the SAME length this truncates at,
 * instead of declaring a second, different ceiling and silently dropping the
 * tail of anything in between.
 */
export const PEOPLE_SEARCH_MAX_QUERY_LENGTH = 100;

/** Max rows returned per search. This is a type-ahead, not a directory browser. */
export const PEOPLE_SEARCH_RESULT_LIMIT = 20;

export interface PersonOption {
  /** The `users.id` stored as the grant value. */
  id: number;
  /** Full name when set, else the email local part. Display only. */
  name: string;
  email: string;
}

export interface PeopleSearchResult {
  /** At most `PEOPLE_SEARCH_RESULT_LIMIT` matches. */
  people: PersonOption[];
  /** True only when a further match exists beyond the ones returned. */
  truncated: boolean;
}

/**
 * Search the directory for people a `user` grant can name.
 *
 * Returns an empty result — never an error — for a query shorter than
 * `PEOPLE_SEARCH_MIN_QUERY_LENGTH`, so a type-ahead can call it on every
 * keystroke.
 *
 * Rows with a NULL email are excluded: `users.email` is nullable (pre-provisioned
 * rows), and a person nobody can address by email cannot be confirmed as the
 * right grantee — returning one would invite granting access to the wrong row.
 * The non-null email is re-checked in the mapping below rather than asserted with
 * a cast, so a later edit to the WHERE clause cannot silently turn `email` into
 * `null` behind a `string` type.
 *
 * Queries one row PAST the cap so `truncated` means "there is a further match",
 * not merely "the result happens to be exactly as long as the cap".
 *
 * Ordering puts an exact email match first, then alphabetical. Neither caller can
 * verify WHICH row the requester meant — that stays a human judgement made
 * against the returned `email` — but the one case where the intended row is
 * knowable (the caller passed a full address) must never be the row that falls
 * off the end of a capped list.
 */
export async function searchPeople(
  query: string
): Promise<PeopleSearchResult> {
  const trimmed = (query ?? "").trim();
  if (trimmed.length < PEOPLE_SEARCH_MIN_QUERY_LENGTH) {
    return { people: [], truncated: false };
  }

  const pattern = `%${escapeSearchPattern(
    trimmed.slice(0, PEOPLE_SEARCH_MAX_QUERY_LENGTH)
  )}%`;
  const displayName = sql<string>`coalesce(nullif(trim(concat_ws(' ', ${users.firstName}, ${users.lastName})), ''), split_part(${users.email}, '@', 1))`;

  const rows = await executeQuery(
    (db) =>
      db
        .select({
          id: users.id,
          name: displayName,
          email: users.email,
        })
        .from(users)
        .where(
          and(
            isNotNull(users.email),
            or(
              ilike(users.email, pattern),
              ilike(users.firstName, pattern),
              ilike(users.lastName, pattern),
              // Match against the CONCATENATED name too, so "Jane Doe" finds a
              // row whose first and last names each match only half the query.
              sql`concat_ws(' ', ${users.firstName}, ${users.lastName}) ILIKE ${pattern}`
            )
          )
        )
        // An EXACT email match sorts first. Without this the order is purely
        // alphabetical, so resolving a known address (the normal case — the
        // caller already has the email and wants its id) could have the one
        // right row pushed past the cap by same-prefix neighbours.
        .orderBy(
          sql`case when lower(${users.email}) = lower(${trimmed}) then 0 else 1 end`,
          asc(users.email)
        )
        .limit(PEOPLE_SEARCH_RESULT_LIMIT + 1),
    "atrium.searchPeople"
  );

  const matches = rows.flatMap((row) =>
    row.email ? [{ id: row.id, name: row.name, email: row.email }] : []
  );
  return {
    people: matches.slice(0, PEOPLE_SEARCH_RESULT_LIMIT),
    truncated: matches.length > PEOPLE_SEARCH_RESULT_LIMIT,
  };
}
