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
 * `ensureDistrictPerson` (`POST /_people`, `psd-atrium add-person`) covers the
 * person a search cannot find: a district colleague who has never signed in and
 * so has no row yet.
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
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import { escapeSearchPattern } from "@/lib/db/drizzle/helpers/search";
import { roles, userRoles, users } from "@/lib/db/schema";

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

export interface EnsureDistrictPersonInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface EnsureDistrictPersonResult {
  person: PersonOption;
  /** False when a row for this email already existed (it is returned as-is). */
  created: boolean;
}

/** Thrown for an email this path refuses to create a row for. */
export class DistrictPersonRejectedError extends Error {}

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/**
 * Return the `users` row for a district STAFF email, creating it if none exists,
 * so a `user` grant can name a colleague who has never signed in (#1860).
 *
 * The row is the same shape `provisionAgentUser` writes — lowercased email,
 * optional names, `cognito_sub` NULL — and the person's first sign-in links it by
 * `lower(email)` (`lib/auth/resolve-user.ts`), keeping this id and every grant
 * made to it. A new row also gets `staff` (source `manual`), the default role
 * sign-in gives a new staff user: the sign-in LINK path never assigns a default
 * role, so a roleless row would sign in with none.
 *
 * Staff only: the email must be on the district domain exactly
 * (`AGENT_WORKSPACE_ALLOWED_DOMAIN`, default `psd401.net`) with a non-numeric
 * local part (all-digit ids are students — `lib/auth/default-role.ts`).
 *
 * Authorizes nothing; the caller gates.
 */
export async function ensureDistrictPerson(
  input: EnsureDistrictPersonInput
): Promise<EnsureDistrictPersonResult> {
  const email = (input.email ?? "").trim().toLowerCase();
  const domain = (process.env.AGENT_WORKSPACE_ALLOWED_DOMAIN?.trim() || "psd401.net").toLowerCase();
  const [localPart, emailDomain] = email.split("@");
  if (!SIMPLE_EMAIL_RE.test(email) || email.length > 255) {
    throw new DistrictPersonRejectedError("Not a valid email address");
  }
  if (emailDomain !== domain) {
    throw new DistrictPersonRejectedError(`Only @${domain} addresses can be added`);
  }
  if (/^\d+$/.test(localPart)) {
    throw new DistrictPersonRejectedError("Student accounts cannot be added");
  }
  const firstName = input.firstName?.trim().slice(0, 255) || null;
  const lastName = input.lastName?.trim().slice(0, 255) || null;

  const { row, created } = await executeTransaction(async (tx) => {
    const [existing] = await tx
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (existing) return { row: existing, created: false };

    const [staffRole] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(sql`lower(${roles.name}) = 'staff'`)
      .limit(1);
    if (!staffRole) throw new Error("Required application role is missing: staff");

    // ON CONFLICT covers a concurrent first sign-in inserting the same address
    // between the SELECT above and here (uq_users_email_lower).
    const [inserted] = await tx
      .insert(users)
      .values({ email, firstName, lastName })
      .onConflictDoNothing()
      .returning({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email });
    if (!inserted) {
      const [raced] = await tx
        .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1);
      return { row: raced, created: false };
    }
    await tx
      .insert(userRoles)
      .values({ userId: inserted.id, roleId: staffRole.id, source: "manual" })
      .onConflictDoNothing();
    return { row: inserted, created: true };
  }, "atrium.ensureDistrictPerson");

  const name =
    [row.firstName, row.lastName].map((part) => part?.trim()).filter(Boolean).join(" ") ||
    localPart;
  return { person: { id: row.id, name, email: row.email ?? email }, created };
}
