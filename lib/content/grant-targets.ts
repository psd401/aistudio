/**
 * Grant target existence checks, shared by the two Atrium grant tables.
 *
 * Atrium stores grants in TWO places, and they are written by two different
 * services:
 *   - `content_visibility_grants`  (object level)     <- `visibility-service.applyGrantsInTx`
 *   - `content_collection_grants`  (collection level) <- `collection-management-service.replaceGrants`
 * Both accept the same `GrantKind` values, both validated only the SHAPE of a
 * value, and both therefore had the same defect: a grant naming a target that
 * does not exist is accepted, stored, and echoed back by every read surface
 * while authorizing nobody.
 *
 * WHY THIS EXISTS (prod, 2026-09-15): `cabinet@psd401.net` had never been
 * ingested by the group sync (whose only selection rule was `prefix = psd-`), so
 * all 34 object-level group grants resolved to nobody and 17 of 20 `group`-level
 * objects were visible only to their owner. An agent "fixed" that by granting
 * Google directory personId `113772684364830001020` to a user whose real
 * `users.id` was 496 — a 21-digit personId satisfies `POSITIVE_INT_RE` exactly as
 * a real id does, so that passed too, at BOTH levels. Every write returned 200
 * and read back intact; the only symptom was a reader getting a 404.
 *
 * Fixing one table alone is not enough: Atrium checks both boundaries (the
 * collection must admit the requester AND the object must grant them), so a
 * silent no-op at either level denies access on its own. One implementation,
 * imported by both services, is the only way they cannot drift.
 *
 * Deliberately limited to `user` and `group` — the two kinds with an
 * authoritative table to check against:
 *   - `role` matches by NAME, and over-validating it as a numeric id is the
 *     Phase 0 bug documented above `assertValidGrant` in `visibility-service.ts`
 *     that made role grants unmatchable end-to-end. Do not "fix" it here.
 *   - `building` / `department` / `grade` are free-text user attributes with no
 *     canonical list.
 */

import { and, eq, inArray } from "drizzle-orm";
import { groups, users } from "@/lib/db/schema";
import type { DbTransaction } from "@/lib/db/drizzle-client";
import { ValidationError } from "./errors";

/** The minimal grant shape both tables share (`CollectionGrant` also carries `access`). */
export interface GrantTarget {
  kind: string;
  value: string;
}

/**
 * Upper bound of `users.id` (int4). A candidate above this is reported as unknown
 * WITHOUT being sent to Postgres — see the note in `assertGrantTargetsExist`.
 */
const INT4_MAX = 2147483647n;

/**
 * Throw a `ValidationError` naming every `user`/`group` grant whose target does
 * not exist. Runs inside the caller's transaction, on values that have ALREADY
 * been normalized (group emails lowercased, values trimmed) so the comparison
 * matches how the read paths match.
 *
 * One batched query per kind, and only for the kinds actually present. A missing
 * target aborts the whole replace rather than applying part of it: both writers
 * are delete-then-insert, so a partial application would leave the object or
 * collection half-shared with no signal which half landed.
 */
export async function assertGrantTargetsExist(
  tx: DbTransaction,
  grants: readonly GrantTarget[]
): Promise<void> {
  const userIds = [
    ...new Set(grants.filter((g) => g.kind === "user").map((g) => g.value)),
  ];
  const groupEmails = [
    ...new Set(grants.filter((g) => g.kind === "group").map((g) => g.value)),
  ];

  // Both kinds are resolved BEFORE anything is thrown, so one rejection names
  // every bad target. Throwing at the first kind would make a caller fix a user
  // id, retry, and only then discover the group was wrong too — and the callers
  // here are usually agents retrying unattended.
  const missingUsers: string[] = [];
  const missingGroups: string[] = [];

  if (userIds.length > 0) {
    // `users.id` is int4. A value past its range must NOT reach the query: the
    // parameter is resolved to int4 from the comparison and Postgres raises
    // `value "…" is out of range for type integer` (22003), which surfaces as a
    // 500 instead of this ValidationError. That is not a hypothetical edge — a
    // 21-digit Google directory personId is exactly the value this check exists
    // to catch, so the headline case is precisely the one that would have blown
    // up. `POSITIVE_INT_RE` has already guaranteed digits-only, so `BigInt` is
    // safe and exact where `Number` would silently lose precision.
    const inRange: string[] = [];
    for (const id of userIds) {
      if (BigInt(id) <= INT4_MAX) inRange.push(id);
      else missingUsers.push(id);
    }
    if (inRange.length > 0) {
      const found = await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, inRange.map(Number)));
      const known = new Set(found.map((r) => String(r.id)));
      missingUsers.push(...inRange.filter((id) => !known.has(id)));
    }
  }

  if (groupEmails.length > 0) {
    // Callers lowercase `group` values, and `groups.group_email` is stored
    // lowercase, so this is an exact match.
    const found = await tx
      .select({ email: groups.groupEmail })
      .from(groups)
      .where(and(inArray(groups.groupEmail, groupEmails), eq(groups.isActive, true)));
    const known = new Set(found.map((r) => r.email.toLowerCase()));
    missingGroups.push(...groupEmails.filter((e) => !known.has(e)));
  }

  if (missingUsers.length === 0 && missingGroups.length === 0) return;

  const parts: string[] = [];
  if (missingUsers.length > 0) {
    parts.push(
      `Unknown user id(s): ${missingUsers.join(", ")}. A 'user' grant takes the AI Studio users.id, not a Google directory personId.`
    );
  }
  if (missingGroups.length > 0) {
    parts.push(
      `Group(s) not synced: ${missingGroups.join(", ")}. Only groups matching a rule in Admin → Groups are synced; add a 'pick' rule for the group, then retry once the hourly sync has run.`
    );
  }
  throw new ValidationError(parts.join(" "), {
    kind: missingUsers.length > 0 ? "user" : "group",
    value: [...missingUsers, ...missingGroups].join(","),
  });
}
