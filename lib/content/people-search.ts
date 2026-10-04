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
 *   - the owner-bound agent broker (`GET /people` in
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
import { users } from "@/lib/db/schema";

/**
 * Shortest accepted query. Below this the search returns an empty list rather
 * than matching a large slice of the directory on one or two characters.
 */
export const PEOPLE_SEARCH_MIN_QUERY_LENGTH = 2;

/** Upper bound on the bound search parameter. */
const MAX_QUERY_LENGTH = 100;

/** Max rows returned per search. This is a type-ahead, not a directory browser. */
export const PEOPLE_SEARCH_RESULT_LIMIT = 20;

/**
 * Escape LIKE/ILIKE metacharacters so a query like `50%` matches literally
 * instead of acting as a wildcard. Mirrors `visibility-service`'s helper; the
 * pattern is still a bound parameter, so this is pattern hygiene, not injection
 * protection.
 */
function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export interface PersonOption {
  /** The `users.id` stored as the grant value. */
  id: number;
  /** Full name when set, else the email local part. Display only. */
  name: string;
  email: string;
}

/**
 * Search the directory for people a `user` grant can name.
 *
 * Returns `[]` — never an error — for a query shorter than
 * `PEOPLE_SEARCH_MIN_QUERY_LENGTH`, so a type-ahead can call it on every
 * keystroke.
 *
 * Rows with a NULL email are excluded: `users.email` is nullable (pre-provisioned
 * rows), and a person nobody can address by email cannot be confirmed as the
 * right grantee — returning one would invite granting access to the wrong row.
 */
export async function searchPeople(query: string): Promise<PersonOption[]> {
  const trimmed = (query ?? "").trim();
  if (trimmed.length < PEOPLE_SEARCH_MIN_QUERY_LENGTH) return [];

  const pattern = `%${escapeLikePattern(trimmed.slice(0, MAX_QUERY_LENGTH))}%`;
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
        .orderBy(asc(users.email))
        .limit(PEOPLE_SEARCH_RESULT_LIMIT),
    "atrium.searchPeople"
  );

  return rows as PersonOption[];
}
