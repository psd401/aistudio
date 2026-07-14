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

import { and, desc, eq, ilike, ne, sql, type SQL } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
  type DrizzleDB,
} from "@/lib/db/drizzle-client";
import {
  contentObjects,
  contentVisibilityGrants,
  users,
} from "@/lib/db/schema";
import {
  canPublishPublic,
  principalOf,
  raisePublishApprovalRequired,
} from "./helpers";
import { objectSelectFields, rowToObjectDTO, type ObjectRowAsText } from "./mappers";
import { NotFoundError, ValidationError } from "./errors";
import { GRANT_KIND_SET, POSITIVE_INT_RE, VISIBILITY_LEVEL_SET } from "./validators";
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

/** Upper bound on a `listVisible` free-text `query` filter (title search). */
const MAX_QUERY_LENGTH = 200;

/**
 * Escape LIKE/ILIKE metacharacters (`\`, `%`, `_`) in user-supplied search text
 * so a query like "50%_off" matches literally instead of acting as a wildcard
 * pattern. Postgres's default LIKE escape character is backslash, so escaping
 * with `\` needs no explicit ESCAPE clause. The pattern itself is still a bound
 * parameter — this is pattern-semantics hygiene, not injection protection.
 */
function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (m) => `\\${m}`);
}

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
  if (!GRANT_KIND_SET.has(grant.kind)) {
    throw new ValidationError(`Invalid grant kind: ${grant.kind}`, { kind: grant.kind });
  }
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
  // Normalize values (trim surrounding whitespace) BEFORE validation/storage. A
  // padded value like " Math " is a non-empty string that passes the required-value
  // check yet can never equal the un-padded users.building attribute it is meant to
  // match — a silently inert grant that authorizes no one. Trimming also collapses a
  // whitespace-only value to "" so assertValidGrant rejects it as missing.
  const normalized = grants.map((g) => ({
    kind: g.kind,
    value: typeof g.value === "string" ? g.value.trim() : g.value,
  }));
  for (const grant of normalized) assertValidGrant(grant);
  // Deduplicate on (kind, value) before INSERT — the uq_cvg constraint enforces
  // uniqueness at the DB level, but a duplicate in the caller's input would throw
  // a 23505 unique_violation and roll back the transaction with a confusing error.
  // The delete-then-insert pattern means any prior duplicates are already gone,
  // so deduping the incoming array is both safe and necessary.
  const seen = new Set<string>();
  const unique = normalized.filter((g) => {
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
 * Validate a level + the grants supplied with it for a level write. Throws a
 * `ValidationError` for an unknown level, grants supplied for a non-group level
 * (a silent drop would widen access), or a grantless group level.
 *
 * DESIGN NOTE — `private` + `user` grants: the read paths
 * (`buildVisibilitySql.privateUserGrant` + `canView`'s user-grant branch) HONOR a
 * per-user grant on a `private` object, and `setLevelInTx` PRESERVES existing ones
 * (`clearNonUserGrantsInTx`). But there is intentionally NO path to *supply* a new
 * grant on a non-group level — `group` is the only grant-authoring level in the
 * UI. The honored-but-unsuppliable `private` user grant exists only so a
 * group→private→(later)group round-trip does not silently revoke a user's access;
 * it is not a feature with its own editor. If a future surface needs to add a
 * per-user grant to a private object, add an explicit, separately-gated path —
 * do NOT relax this guard (which would let a `setLevel` call widen access).
 */
function assertWritableLevel(
  level: string,
  grants: VisibilityGrant[] | undefined
): void {
  if (!VISIBILITY_LEVEL_SET.has(level)) {
    throw new ValidationError(`Invalid visibility level: ${level}`, { level });
  }
  const grantCount = grants?.length ?? 0;
  // Reject grants supplied for a non-group level rather than silently dropping
  // them: those levels are not grant-keyed, and a caller that sent grants (e.g. a
  // future REST/MCP path) intended to RESTRICT access — silently clearing them
  // would widen access to exactly the principals the caller meant to scope.
  if (level !== "group" && grantCount > 0) {
    throw new ValidationError("grants are only valid for group visibility", {
      level,
      grantCount,
    });
  }
  if (level === "group" && grantCount === 0) {
    throw new ValidationError("group visibility requires at least one grant", {
      level,
    });
  }
}

/**
 * Extra columns a level-write may fold into its single UPDATE. Deliberately an
 * EXPLICIT ALLOWLIST (not `Record<string, unknown>`): Drizzle maps any recognized
 * column key in the spread to a SQL assignment, so an open record would let a
 * caller fold in `ownerUserId`, `slug`, `collectionId`, etc. — silently
 * transferring ownership or retargeting the row inside a write that already holds
 * the `FOR UPDATE` lock and passed auth. Only `status` is foldable today (the
 * publish path). Add columns here explicitly as new needs arise; never widen to an
 * arbitrary record.
 */
type ExtraSet = {
  status?: "draft" | "published" | "archived";
};

/**
 * Reconcile the persisted grant set with the target level (see `setLevelInTx`
 * JSDoc for the per-level rules): group replaces the full set, private preserves
 * `user`-kind grants, internal/public clear everything.
 */
async function reconcileGrantsInTx(
  tx: DbTransaction,
  objectId: string,
  level: string,
  grants: VisibilityGrant[] | undefined
): Promise<void> {
  if (level === "group") {
    await applyGrantsInTx(tx, objectId, grants ?? []);
  } else if (level === "private") {
    await clearNonUserGrantsInTx(tx, objectId);
  } else {
    await applyGrantsInTx(tx, objectId, []);
  }
}

/**
 * Replace an object's visibility level (and, for `group`, its grants) inside the
 * caller's transaction — the atomic primitive shared by the standalone
 * `setLevel` (the visibility editor) and the publish path (which widens
 * visibility in the same transaction it records the publication).
 *
 * Semantics:
 * - `level === "internal"` / `level === "public"` clears ALL existing grants —
 *   neither read path (`buildVisibilitySql`, `canView`) consults grants for these
 *   levels, so they always land with zero grants on the row.
 * - `level === "private"` clears every grant EXCEPT `user`-kind grants. Both read
 *   paths honor a per-user grant on a `private` object (`buildVisibilitySql`'s
 *   `privateUserGrant` EXISTS clause and `canView`'s `grants.some(... kind ===
 *   "user")` branch), so deleting them on a level-write would silently revoke
 *   access the read paths still grant — a write/read contradiction. We preserve
 *   them so "keep this private" (re-saving `private`) is non-destructive.
 * - The caller MUST NOT *supply* grants for a non-group level: passing a non-empty
 *   `grants` array with such a level throws `ValidationError` rather than silently
 *   dropping it, because a caller that sent grants intended to RESTRICT access
 *   and a silent drop would widen it. (Existing `user`-grant preservation above is
 *   about *retaining persisted* grants, not accepting *supplied* ones.)
 * - `level === "group"` requires at least one grant — a grantless group object
 *   is visible to no one but the owner/admin (private semantics without saying
 *   so), almost always a mistake (mirrors `contentService.create`).
 *
 * Does NOT run any permission check — callers gate with `assertCanEdit` first.
 *
 * `extraSet` folds additional columns into the single level UPDATE rather than
 * forcing the caller to issue a second UPDATE on the same row in the same
 * transaction (the publish path uses it for `status: "published"` so the row is
 * touched once, not twice with a doubly-stamped `updatedAt`). It does NOT change
 * `status` itself — that remains the caller's concern.
 */
async function setLevelInTx(
  tx: DbTransaction,
  objectId: string,
  visibility: VisibilityInput,
  extraSet: ExtraSet = {}
): Promise<void> {
  const level = visibility.level;
  assertWritableLevel(level, visibility.grants);

  // Reconcile the persisted grant set with the target level — both inside the one
  // transaction so the level and its grant set are never observed apart.
  await reconcileGrantsInTx(tx, objectId, level, visibility.grants);

  await tx
    .update(contentObjects)
    // Spread `extraSet` FIRST so the validated `visibilityLevel`/`updatedAt`
    // always win — a future caller passing those keys in `extraSet` cannot
    // override the level that just passed VISIBILITY_LEVEL_SET validation.
    .set({ ...extraSet, visibilityLevel: level, updatedAt: new Date() })
    .where(eq(contentObjects.id, objectId));
}

/**
 * Clear every grant on an object EXCEPT `user`-kind grants, inside the caller's
 * transaction. Used when an object transitions to `private`: the read paths still
 * honor per-user grants on a private object, so those must survive a level-write
 * that no longer keys off role/building/department/grade grants. (Group grants of
 * those kinds are meaningless once the object is private and are dropped.)
 */
async function clearNonUserGrantsInTx(
  tx: DbTransaction,
  objectId: string
): Promise<void> {
  await tx
    .delete(contentVisibilityGrants)
    .where(
      and(
        eq(contentVisibilityGrants.objectId, objectId),
        ne(contentVisibilityGrants.grantKind, "user")
      )
    );
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

    if (obj.visibilityLevel === "private") {
      // Private is owner/admin only, plus any explicit per-user grant. A caller
      // with no userId (anonymous / autonomous-agent) can never match a `user`
      // grant, so skip the grantsFor DB round-trip entirely — both for efficiency
      // AND to close the timing side-channel that the existence-masking
      // (notFound vs forbidden) is meant to remove. The SQL path
      // (buildVisibilitySql.privateUserGrant) short-circuits the same way.
      if (principal.userId == null) return false;
      const grants = await grantsFor(obj.id);
      return grants.some(
        (g) => g.kind === "user" && String(principal.userId) === g.value
      );
    }

    if (obj.visibilityLevel === "group") {
      // Gate the grant sweep on the `group` level explicitly — `buildVisibilitySql`
      // gates its EXISTS subquery with `AND visibility_level = 'group'`, so a stale
      // grant on a non-group object (a direct DB edit or a future migration path)
      // must NOT authorize a principal here that the SQL predicate would deny. The
      // explicit `=== "group"` check keeps the two paths equivalent AND skips the DB
      // round-trip for any non-group level (which never consults grants).
      const grants = await grantsFor(obj.id);
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
    }

    // Any level not handled above (e.g. a future level added to the enum but not
    // yet wired into the visibility rules) denies by default — fail closed, never
    // leak. Mirror the new level in buildVisibilitySql in the same commit.
    return false;
  },

  /**
   * Reconcile an object's grants for a target level, enforcing the same level
   * invariants as `setLevelInTx` (group needs ≥1 grant and only group accepts
   * supplied grants; private preserves persisted `user` grants; internal/public
   * clear all). Used by `contentService.create`, which writes the level inline on
   * INSERT and so cannot route the grants through `setLevelInTx`'s UPDATE — this
   * gives it the same guard without the level write.
   */
  async applyGrantsForLevel(
    tx: DbTransaction,
    objectId: string,
    level: string,
    grants: VisibilityGrant[]
  ): Promise<void> {
    assertWritableLevel(level, grants);
    await reconcileGrantsInTx(tx, objectId, level, grants);
  },

  /**
   * Validate a level + its grants WITHOUT writing — lets a caller that builds the
   * row in a single INSERT (`contentService.create`) fail an invalid level/grant
   * combination (e.g. a collection-defaulted `group` with no grants) BEFORE the
   * INSERT, rather than rolling back an already-written row. Same rules as
   * `applyGrantsForLevel` / `setLevelInTx`.
   */
  assertWritableLevel(level: string, grants: VisibilityGrant[] | undefined): void {
    assertWritableLevel(level, grants);
  },

  /**
   * Replace an object's grants AND level inside the caller's transaction — used
   * by the publish path, which widens visibility in the same transaction it
   * records the publication. `extraSet` folds extra columns (e.g.
   * `status: "published"`) into the single level UPDATE so the publish path
   * touches the row once. See `setLevelInTx` for the level/grant semantics.
   */
  async setLevelInTx(
    tx: DbTransaction,
    objectId: string,
    visibility: VisibilityInput,
    extraSet: ExtraSet = {}
  ): Promise<void> {
    await setLevelInTx(tx, objectId, visibility, extraSet);
  },

  /**
   * Set an object's visibility level (and, for `group`, replace its grants) as a
   * standalone, atomic write — the visibility editor's persistence path (§12.4
   * "publish-widening" generalized to any level change).
   *
   * The object must exist (404 otherwise) and the caller is expected to have
   * already passed `assertCanEdit`. Does NOT change `status`. Returns the new
   * level so the surface can reflect it without a re-read.
   *
   * §26.4 — widening to `public` through this standalone path is the SAME
   * privilege boundary as `publishService.publish`'s visibility widen, so it
   * enforces the identical `canPublishPublic` gate (+ approval-queue event) —
   * otherwise a `content:update`-only caller could reach "public" by calling
   * `set_visibility` instead of `publish`.
   */
  async setLevel(
    req: Requester,
    objectId: string,
    visibility: VisibilityInput,
    opts: { hasPublishPublicCapability?: boolean } = {}
  ): Promise<{ visibilityLevel: VisibilityLevel }> {
    // Whether this caller holds the §26.4 public-publish authority (pure, no IO).
    // The ACTUAL gate decision (is this a NEW public exposure?) is made INSIDE the
    // transaction against the FOR-UPDATE-locked level — never against a pre-lock
    // read. Deciding it before the lock is a TOCTOU hole: a concurrent narrow
    // (public → internal) between the read and the locked write would leave the
    // "already public → no-op" branch taken against a stale `public`, letting an
    // unauthorized widen-back-to-public slip past approval.
    const mayPublishPublic = canPublishPublic(
      req,
      opts.hasPublishPublicCapability ?? false
    );
    await executeTransaction(async (tx) => {
      // Guard against a missing object inside the tx so the level write does not
      // silently no-op (UPDATE ... WHERE id = <absent> affects zero rows). Lock
      // the row FOR UPDATE so a concurrent delete cannot slip between this check
      // and the setLevelInTx update, and read the CURRENT level under the same lock
      // for the §26.4 gate below (race-free).
      const rows = await tx
        .select({
          id: contentObjects.id,
          visibilityLevel: contentObjects.visibilityLevel,
        })
        .from(contentObjects)
        .where(eq(contentObjects.id, objectId))
        .for("update")
        .limit(1);
      if (!rows[0]) {
        throw new NotFoundError("Content not found", { objectId });
      }

      // §26.4 — widening to `public` is gated iff the locked row is not ALREADY
      // public (a no-op re-save of already-public content is not a new exposure and
      // passes). Same privilege boundary as `publishService.publish`'s widen; here
      // it is race-free because the check reads the level under the FOR UPDATE lock
      // held through the write. Throwing rolls the transaction back — nothing widens.
      if (
        visibility.level === "public" &&
        rows[0].visibilityLevel !== "public" &&
        !mayPublishPublic
      ) {
        // Shared with `publishService`'s visibility-widen gate (`./helpers`) so the
        // emitted event shape + fail-closed behavior stay identical across every
        // §26.4 gate site.
        raisePublishApprovalRequired(
          req,
          "Widening visibility to public requires approval",
          { objectId },
          { objectId }
        );
      }

      await setLevelInTx(tx, objectId, visibility);
    }, "content.setLevel");
    return { visibilityLevel: visibility.level };
  },

  /**
   * Count requester-visible, non-archived objects grouped by collection — the
   * collection tree's "does this section hold content I can see?" check, pushed
   * fully into SQL using the same `buildVisibilitySql` predicate as `listVisible`.
   *
   * Bounded by the number of collections, NEVER the object count: a requester
   * with more visible objects than `listVisible`'s page cap cannot have a real
   * section silently pruned from their tree because its only visible objects fell
   * outside the most-recent page. Objects with a null collection are ignored
   * (they belong to no section). Published + draft both count (archived excluded),
   * matching the unfiltered `listVisible` the tree previously derived counts from.
   */
  async visibleCountsByCollection(req: Requester): Promise<Map<string, number>> {
    const principal = principalOf(req);
    const o = contentObjects;
    const visiblePredicate = buildVisibilitySql(principal);
    const rows = await executeQuery(
      (db: DrizzleDB) =>
        db
          .select({
            collectionId: o.collectionId,
            count: sql<number>`count(*)::int`,
          })
          .from(o)
          .where(
            and(
              sql`${o.status} <> 'archived'`,
              sql`${o.collectionId} IS NOT NULL`,
              visiblePredicate
            )
          )
          .groupBy(o.collectionId),
      "content.visibleCountsByCollection"
    );
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.collectionId) counts.set(row.collectionId, Number(row.count));
    }
    return counts;
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
    if (filter.owner === "shared") {
      // "Shared with me": content the caller can see but does not own, that
      // reached them through an explicit grant (group/private) rather than the
      // public/internal firehose. Additive AND on top of `visiblePredicate`, so
      // it can only narrow the already-authorized set. A guest owns nothing and
      // has no personal grants, so it yields no rows.
      if (principal.userId != null) {
        filters.push(sql`${o.ownerUserId} <> ${principal.userId}`);
        filters.push(sql`${o.visibilityLevel} IN ('group', 'private')`);
      } else {
        filters.push(sql`false`);
      }
    }
    if (filter.tag) {
      // Bound parameter (injection-safe); cap length so an oversized tag string
      // cannot be pushed to the driver on every list call. Array-overlap (`&&`
      // against a one-element text[]) rather than `= ANY(tags)`: only the
      // overlap operator can use the `idx_content_tags` GIN index (migration
      // 085) — `<tag> = ANY(column)` forces a sequential scan.
      const tag = filter.tag.slice(0, MAX_TAG_LENGTH);
      filters.push(sql`${o.tags} && ARRAY[${tag}]::text[]`);
    }
    if (filter.query) {
      // Case-insensitive title substring search. Bounded + LIKE-escaped so an
      // oversized or wildcard-bearing query can neither bloat the bound
      // parameter nor act as a pattern; the pattern is a bound parameter
      // (injection-safe).
      const q = escapeLikePattern(filter.query.slice(0, MAX_QUERY_LENGTH));
      filters.push(ilike(o.title, `%${q}%`));
    }

    // List-only projection: the shared `objectSelectFields` (single-object loads)
    // stays untouched; here we additionally resolve the owner's DISPLAY NAME via a
    // LEFT JOIN on `users` — full name, or the email LOCAL PART when the name is
    // blank (never the full address: cards render to every viewer who can see the
    // object, so the domain-qualified email stays un-broadcast), else null.
    // Presentation metadata only (the library cards show "who owns this"); owner
    // permission is always keyed on `ownerUserId`, never this string.
    const listSelectFields = {
      ...objectSelectFields,
      ownerName: sql<string | null>`coalesce(nullif(trim(concat_ws(' ', ${users.firstName}, ${users.lastName})), ''), split_part(${users.email}, '@', 1))`,
    };

    const rows = await executeQuery(
      (db: DrizzleDB) =>
        db
          .select(listSelectFields)
          .from(o)
          // LEFT JOIN (not inner), defensively: today the NOT NULL FK to
          // users(id) (no ON DELETE action) means every row has a matching
          // owner, but a future FK relaxation must degrade to a null ownerName,
          // never drop the row from the library.
          .leftJoin(users, eq(users.id, o.ownerUserId))
          .where(and(...filters))
          // `id` is the deterministic tiebreaker: `updated_at` alone is not unique
          // (a bulk import stamps many rows at once), and Postgres gives no stable
          // order for ties — so sequential offset pages could re-return or skip a
          // straddling row. The unique PK makes offset pagination (e.g. the OKF
          // exporter's page loop) safe.
          .orderBy(desc(o.updatedAt), desc(o.id))
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
