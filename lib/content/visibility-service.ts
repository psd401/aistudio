/**
 * Atrium visibility service
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). The permission boundary for content:
 * `canView` (the predicate enforced everywhere), grant application, and the
 * permission-pushed `listVisible` query (filtering in SQL, never load-then-drop).
 *
 * See docs/features/atrium-design-spec.md §12.
 *
 * Phase 0 ships the core read/grant/list logic the issue calls for. Publish-time
 * visibility widening (`setLevel`) lands with the publish service in Phase 5/7.
 */

import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
  type DrizzleDB,
} from "@/lib/db/drizzle-client";
import {
  contentObjects,
  contentVisibilityGrants,
} from "@/lib/db/schema";
import { principalOf } from "./helpers";
import { objectSelectFields, rowToObjectDTO, type ObjectRowAsText } from "./mappers";
import { NotFoundError, ValidationError } from "./errors";
import type {
  ContentObjectDTO,
  ListFilter,
  Principal,
  Requester,
  VisibilityGrant,
  VisibilityInput,
  VisibilityLevel,
} from "./types";

/** Upper bound on a `listVisible` tag filter, mirroring the tags column width. */
const MAX_TAG_LENGTH = 100;

/** A positive-integer ID string (no leading zeros required, no sign, no spaces). */
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

/** Upper bound on a grant value, mirroring the `grant_value varchar(255)` column. */
const MAX_GRANT_VALUE_LENGTH = 255;

/**
 * Validate a grant before it is persisted. Only a `user` grant carries a numeric
 * id (the `users.id`, matched as `String(userId)` in §12.2). A `role` grant
 * carries the role *name* (e.g. "staff"), because `canView` matches it against
 * `principal.roles` — which are role NAMES (`getUserRoles` returns
 * `roles.name`), never role ids. The remaining kinds (building / department /
 * grade) carry the user-attribute string verbatim. Rejecting an empty or
 * over-long value here prevents, e.g., an empty-string role grant from matching
 * unintended principals once the `g.grant_value = ''` comparison runs.
 *
 * NOTE: a `role` grant value MUST NOT be validated as a numeric id. Doing so
 * (the Phase 0 behaviour) made role-based group grants unmatchable end-to-end:
 * any value that passed validation (a number) could never equal a role name, so
 * the grant silently granted access to no one. role=name / user=id is the §12.2
 * contract and what `canView` / `buildVisibilitySql` both match on.
 */
function assertValidGrant(grant: VisibilityGrant): void {
  const value = grant.value;
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("Grant value is required", { kind: grant.kind });
  }
  if (value.length > MAX_GRANT_VALUE_LENGTH) {
    throw new ValidationError("Grant value exceeds maximum length", {
      kind: grant.kind,
    });
  }
  // Only `user` grants are numeric ids; `role` matches by NAME (see above).
  if (grant.kind === "user" && !POSITIVE_INT_RE.test(value)) {
    throw new ValidationError(
      `Grant value for 'user' must be a positive-integer id`,
      { kind: grant.kind, value }
    );
  }
}

/**
 * The SQL form of `canView` for the permission-pushed `listVisible` query. Built
 * once per request from the principal so listing/retrieval never load-then-drop
 * (§12.3).
 *
 * MUST stay logically equivalent to `visibilityService.canView` below — the two
 * implement the same visibility rules in two languages (SQL here, JS there). Any
 * change to a visibility rule MUST be mirrored in BOTH or list and point-read
 * will disagree (a divergence the mocked unit tests cannot catch). When you edit
 * one, edit the other in the same commit.
 */
function buildVisibilitySql(principal: Principal): SQL {
  if (principal.isAdmin) return sql`true`;

  const o = contentObjects;
  const userIdText = principal.userId != null ? String(principal.userId) : null;
  const roleList = principal.roles;
  const gradeList = principal.gradeLevels ?? [];

  const authenticated = userIdText != null || roleList.length > 0;
  // INVARIANT: owners always see their own content regardless of visibility level
  // (encoded as the unconditional `OR (${ownerMatch})` in the predicate below).
  // This MUST stay equivalent to `canView`'s owner check (the
  // `principal.userId === obj.ownerUserId` branch). If owner visibility is ever
  // restricted (e.g. an owner can no longer read archived content), this
  // unconditional form would silently leak that content to owners in `listVisible`
  // — scope it here AND in `canView` in the same commit.
  const ownerMatch =
    userIdText != null
      ? sql`${o.ownerUserId} = ${principal.userId}`
      : sql`false`;
  // `g.grant_value IN (...)` over a bound list. Empty lists render as `false`
  // (postgres rejects both an empty `IN ()` and an empty `ANY(())`). Each value
  // is a separate bound parameter, so this is injection-safe.
  const inList = (values: string[]) =>
    values.length > 0
      ? sql`g.grant_value IN (${sql.join(
          values.map((v) => sql`${v}`),
          sql`, `
        )})`
      : sql`false`;
  const roleMatch = inList(roleList);
  const gradeMatch = inList(gradeList);
  const buildingMatch =
    principal.building != null
      ? sql`g.grant_value = ${principal.building}`
      : sql`false`;
  const departmentMatch =
    principal.department != null
      ? sql`g.grant_value = ${principal.department}`
      : sql`false`;
  const userGrantMatch =
    userIdText != null ? sql`g.grant_value = ${userIdText}` : sql`false`;
  const privateUserGrant =
    userIdText != null
      ? sql`EXISTS (
          SELECT 1 FROM ${contentVisibilityGrants} g2
          WHERE g2.object_id = ${o.id}
            AND g2.grant_kind = 'user'
            AND g2.grant_value = ${userIdText}
        )`
      : sql`false`;

  return sql`(
    ${o.visibilityLevel} = 'public'
    OR (${o.visibilityLevel} = 'internal' AND ${authenticated ? sql`true` : sql`false`})
    OR (${ownerMatch})
    OR (${o.visibilityLevel} = 'group' AND EXISTS (
      SELECT 1 FROM ${contentVisibilityGrants} g
      WHERE g.object_id = ${o.id} AND (
        (g.grant_kind = 'role'       AND ${roleMatch})
        OR (g.grant_kind = 'building'   AND ${buildingMatch})
        OR (g.grant_kind = 'department' AND ${departmentMatch})
        OR (g.grant_kind = 'grade'      AND ${gradeMatch})
        OR (g.grant_kind = 'user'       AND ${userGrantMatch})
      )
    ))
    OR (${o.visibilityLevel} = 'private' AND ${privateUserGrant})
  )`;
}

/** A loaded object's fields `canView` needs (subset of the DTO). */
export interface ViewableObject {
  id: string;
  ownerUserId: number;
  visibilityLevel: "private" | "group" | "internal" | "public";
}

/**
 * Replace an object's grants with the supplied set (delete-then-insert) inside
 * the caller's transaction. Validates every grant value first so a bad value
 * aborts the whole replace (no partial application). A no-op delete-only when
 * `grants` is empty (clears grants).
 */
async function applyGrantsInTx(
  tx: DbTransaction,
  objectId: string,
  grants: VisibilityGrant[]
): Promise<void> {
  for (const grant of grants) assertValidGrant(grant);
  // Deduplicate on (kind, value) before INSERT — the uq_cvg constraint enforces
  // uniqueness at the DB level, but a duplicate in the caller's input would throw
  // a 23505 unique_violation and roll back the transaction with a confusing error.
  // The delete-then-insert pattern means any prior duplicates are already gone,
  // so deduping the incoming array is both safe and necessary.
  const seen = new Set<string>();
  const unique = grants.filter((g) => {
    const key = `${g.kind}:${g.value}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  await tx
    .delete(contentVisibilityGrants)
    .where(eq(contentVisibilityGrants.objectId, objectId));
  if (unique.length > 0) {
    await tx.insert(contentVisibilityGrants).values(
      unique.map((g) => ({
        objectId,
        grantKind: g.kind,
        grantValue: g.value,
      }))
    );
  }
}

/**
 * Replace an object's visibility level (and, for `group`, its grants) inside the
 * caller's transaction — the atomic primitive shared by the standalone
 * `setLevel` (the visibility editor) and the publish path (which widens
 * visibility in the same transaction it records the publication).
 *
 * Semantics:
 * - `level !== "group"` clears all grants (a non-group level is not grant-keyed;
 *   leaving stale grants would silently widen access if the level were later
 *   flipped back to `group`). The clear runs through `applyGrants(tx, id, [])`.
 * - `level === "group"` requires at least one grant — a grantless group object
 *   is visible to no one but the owner/admin (private semantics without saying
 *   so), almost always a mistake (mirrors `contentService.create`).
 *
 * Does NOT change `status` (that is the publish path's concern) and does NOT run
 * any permission check — callers gate with `assertCanEdit` first.
 */
async function setLevelInTx(
  tx: DbTransaction,
  objectId: string,
  visibility: VisibilityInput
): Promise<void> {
  const level = visibility.level;
  const grants = level === "group" ? visibility.grants ?? [] : [];

  if (level === "group" && grants.length === 0) {
    throw new ValidationError("group visibility requires at least one grant", {
      objectId,
    });
  }

  // Replace grants first (validates each value), then the level — both inside
  // the one transaction so the level and its grant set are never observed apart.
  await applyGrantsInTx(tx, objectId, grants);
  await tx
    .update(contentObjects)
    .set({ visibilityLevel: level, updatedAt: new Date() })
    .where(eq(contentObjects.id, objectId));
}

/** Load the normalized grants for an object. */
async function grantsFor(objectId: string): Promise<VisibilityGrant[]> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          kind: contentVisibilityGrants.grantKind,
          value: contentVisibilityGrants.grantValue,
        })
        .from(contentVisibilityGrants)
        .where(eq(contentVisibilityGrants.objectId, objectId)),
    "content.grantsFor"
  );
  return rows.map((r) => ({ kind: r.kind, value: r.value }));
}

export const visibilityService = {
  grantsFor,

  /**
   * The single predicate that gates every content read. Evaluated against the
   * requester's principal.
   *
   * MUST stay logically equivalent to `buildVisibilitySql` above — the SQL path
   * (`listVisible`) and this in-memory path implement the same rules. Any change
   * to a visibility rule MUST be mirrored in BOTH or list and point-read will
   * disagree and leak (the mocked unit tests cannot catch a SQL-only divergence).
   * When you edit one, edit the other in the same commit.
   */
  async canView(req: Requester, obj: ViewableObject): Promise<boolean> {
    if (obj.visibilityLevel === "public") return true;

    const principal = principalOf(req);
    // Unauthenticated (no user, no roles) can only ever see public.
    if (principal.userId == null && principal.roles.length === 0) return false;

    // Admin short-circuit BEFORE level checks — mirrors the top-level guard in
    // buildVisibilitySql. Keeping the ordering identical prevents latent divergence
    // if a future level is inserted that could return false for admins before reaching
    // the isAdmin check (e.g. a `restricted` level with sub-permission checks).
    if (principal.isAdmin) return true;

    if (obj.visibilityLevel === "internal") {
      // Any authenticated principal (a user, or an agent with a role).
      return principal.userId != null || principal.roles.length > 0;
    }
    if (principal.userId != null && principal.userId === obj.ownerUserId) {
      return true;
    }

    const grants = await grantsFor(obj.id);

    if (obj.visibilityLevel === "private") {
      // Private is owner/admin only, plus any explicit per-user grant.
      return grants.some(
        (g) =>
          g.kind === "user" &&
          principal.userId != null &&
          String(principal.userId) === g.value
      );
    }

    // group:
    return grants.some(
      (g) =>
        (g.kind === "role" && principal.roles.includes(g.value)) ||
        (g.kind === "building" && principal.building === g.value) ||
        (g.kind === "department" && principal.department === g.value) ||
        (g.kind === "grade" &&
          (principal.gradeLevels ?? []).includes(g.value)) ||
        (g.kind === "user" &&
          principal.userId != null &&
          String(principal.userId) === g.value)
    );
  },

  /**
   * Replace an object's grants with the supplied set (delete-then-insert) inside
   * the caller's transaction. A no-op (clears grants) when `grants` is empty.
   */
  async applyGrants(
    tx: DbTransaction,
    objectId: string,
    grants: VisibilityGrant[]
  ): Promise<void> {
    await applyGrantsInTx(tx, objectId, grants);
  },

  /**
   * Replace an object's grants AND level inside the caller's transaction — used
   * by the publish path, which widens visibility in the same transaction it
   * records the publication. See `setLevelInTx` for the level/grant semantics.
   */
  async setLevelInTx(
    tx: DbTransaction,
    objectId: string,
    visibility: VisibilityInput
  ): Promise<void> {
    await setLevelInTx(tx, objectId, visibility);
  },

  /**
   * Set an object's visibility level (and, for `group`, replace its grants) as a
   * standalone, atomic write — the visibility editor's persistence path (§12.4
   * "publish-widening" generalized to any level change).
   *
   * The object must exist (404 otherwise) and the caller is expected to have
   * already passed `assertCanEdit`. Does NOT change `status`. Returns the new
   * level so the surface can reflect it without a re-read.
   */
  async setLevel(
    objectId: string,
    visibility: VisibilityInput
  ): Promise<{ visibilityLevel: VisibilityLevel }> {
    await executeTransaction(async (tx) => {
      // Guard against a missing object inside the tx so the level write does not
      // silently no-op (UPDATE ... WHERE id = <absent> affects zero rows). Lock
      // the row FOR UPDATE so a concurrent delete cannot slip between this check
      // and the setLevelInTx update.
      const rows = await tx
        .select({ id: contentObjects.id })
        .from(contentObjects)
        .where(eq(contentObjects.id, objectId))
        .for("update")
        .limit(1);
      if (!rows[0]) {
        throw new NotFoundError("Content not found", { objectId });
      }
      await setLevelInTx(tx, objectId, visibility);
    }, "content.setLevel");
    return { visibilityLevel: visibility.level };
  },

  /**
   * Permission-pushed listing: returns exactly the objects visible to the
   * requester, filtering in SQL. Mirrors `canView`'s logic (§12.3). Optional
   * filters narrow by collection/kind/tag/status.
   */
  async listVisible(
    req: Requester,
    filter: ListFilter = {}
  ): Promise<ContentObjectDTO[]> {
    const principal = principalOf(req);
    // `?? N` only coalesces null/undefined, not NaN. A NaN from a query-string
    // parse (e.g. parseInt('abc')) survives Math.min/Math.max — Math.max(NaN, 1)
    // is NaN — and `.limit(NaN)` emits `LIMIT NaN`, a Postgres syntax error
    // (unhandled 500). Treat any non-finite value as the default.
    const limit = Number.isFinite(filter.limit)
      ? Math.min(Math.max(filter.limit as number, 1), 200)
      : 50;
    const offset = Number.isFinite(filter.offset)
      ? Math.max(filter.offset as number, 0)
      : 0;

    const o = contentObjects;
    const visiblePredicate = buildVisibilitySql(principal);

    const filters = [
      // archived objects are excluded unless explicitly requested.
      filter.status
        ? eq(o.status, filter.status)
        : sql`${o.status} <> 'archived'`,
      visiblePredicate,
    ];
    if (filter.collectionId) filters.push(eq(o.collectionId, filter.collectionId));
    if (filter.kind) filters.push(eq(o.kind, filter.kind));
    if (filter.tag) {
      // Bound parameter (injection-safe); cap length so an oversized tag string
      // cannot be pushed to the driver on every list call.
      const tag = filter.tag.slice(0, MAX_TAG_LENGTH);
      filters.push(sql`${tag} = ANY(${o.tags})`);
    }

    const rows = await executeQuery(
      (db: DrizzleDB) =>
        db
          .select(objectSelectFields)
          .from(o)
          .where(and(...filters))
          .orderBy(desc(o.updatedAt))
          .limit(limit)
          .offset(offset),
      "content.listVisible"
    );

    // Cast each row to the text-timestamp shape, matching content-service's
    // per-call pattern: the Drizzle projection types `tags` as nullable and
    // narrows enum columns, so it is not directly assignable to the mapper's
    // ObjectRowAsText parameter.
    return rows.map((row) => rowToObjectDTO(row as ObjectRowAsText));
  },
};
