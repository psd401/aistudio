/**
 * Per-resource access grants — the shared authorization helper (Epic #1202
 * Phase 3, #1206).
 *
 * A resource (an AI model, an Assistant Architect assistant, or an agent skill)
 * may carry direct access grants keyed on a ROLE (by name) or a synced Google
 * Directory GROUP (by email), stored in `resource_access_grants` (migration 111).
 *
 * SEMANTICS (identical to the pre-existing ai_models.allowed_roles contract):
 *   - ZERO grant rows for a resource  = UNRESTRICTED (everyone may access).
 *   - ANY matching grant row          = allowed.
 *   - ADMINISTRATORS always pass.
 *
 * This is the resource-scoped authorization axis — NOT a Capability (role-gated
 * UI feature) and NOT a Scope (API-key permission). See
 * docs/architecture/capabilities-and-scopes.md; do not collapse the three.
 *
 * Every email/role comparison lowercases BOTH sides. Storage is lowercase by
 * convention (group emails via normalizeEmail; role names are already lowercase)
 * but no constraint enforces it, so the auth decision must not trust it — mirrors
 * `reconcileUserManagedRoles` / `listUserGroupEmailsByUserId`.
 */

import { and, eq, sql } from "drizzle-orm";
import { executeQuery, toPgRows, type DbTransaction } from "@/lib/db/drizzle-client";
import {
  resourceAccessGrants,
  type ResourceGrantType,
  type ResourceGrantKind,
} from "@/lib/db/schema";
import { normalizeEmail } from "@/lib/groups/normalize";

/** A single grant on a resource, reduced to what the editor reads/writes. */
export interface ResourceGrant {
  grantKind: ResourceGrantKind;
  /** Role name (kind='role') or lowercased group email (kind='group'). */
  grantValue: string;
}

/**
 * Normalize a resource id to its text storage form. Serial-int resources
 * (models, assistants) become decimal text; uuid resources (skills) pass through
 * as their string. Callers pass a number or a uuid transparently.
 */
function resourceIdText(resourceId: number | string): string {
  return typeof resourceId === "number" ? String(resourceId) : resourceId;
}

/**
 * Whether a user may access a single resource. The canonical per-resource gate
 * for execution paths (model resolution, assistant execute, skill invocation).
 *
 * One round-trip: a boolean-OR of four EXISTS predicates —
 *   1. the resource has NO grants (unrestricted), OR
 *   2. the user is an administrator, OR
 *   3. a `role` grant matches one of the user's roles (by name, case-insensitive), OR
 *   4. a `group` grant matches the user's membership of an ACTIVE synced group.
 *
 * Fails CLOSED on a malformed user id (a non-positive / NaN id yields no
 * memberships and no roles, so only an unrestricted resource is allowed).
 */
export async function userCanAccessResource(
  userId: number,
  resourceType: ResourceGrantType,
  resourceId: number | string
): Promise<boolean> {
  const idText = resourceIdText(resourceId);
  const validUser = Number.isInteger(userId) && userId > 0;

  const result = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT (
          NOT EXISTS (
            SELECT 1 FROM resource_access_grants g
             WHERE g.resource_type = ${resourceType}
               AND g.resource_id = ${idText}
          )
          OR (
            ${validUser} AND EXISTS (
              SELECT 1 FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
               WHERE ur.user_id = ${userId}
                 AND lower(r.name) = 'administrator'
            )
          )
          OR (
            ${validUser} AND EXISTS (
              SELECT 1 FROM resource_access_grants g
                JOIN roles r ON lower(r.name) = lower(g.grant_value)
                JOIN user_roles ur ON ur.role_id = r.id AND ur.user_id = ${userId}
               WHERE g.resource_type = ${resourceType}
                 AND g.resource_id = ${idText}
                 AND g.grant_kind = 'role'
            )
          )
          OR (
            ${validUser} AND EXISTS (
              SELECT 1 FROM resource_access_grants g
                JOIN groups grp ON lower(grp.group_email) = lower(g.grant_value)
                                AND grp.is_active = true
                JOIN group_members gm ON gm.group_id = grp.id
                JOIN users u ON lower(u.email) = lower(gm.member_email)
               WHERE g.resource_type = ${resourceType}
                 AND g.resource_id = ${idText}
                 AND g.grant_kind = 'group'
                 AND u.id = ${userId}
            )
          )
        ) AS allowed
      `),
    "userCanAccessResource"
  );

  const [row] = toPgRows<{ allowed: boolean }>(result);
  return row?.allowed === true;
}

/**
 * Filter a set of candidate resource ids to those the user may access — the
 * batch gate for list surfaces (e.g. GET /api/models), avoiding the N+1 of
 * calling `userCanAccessResource` per row.
 *
 * A candidate is accessible when it has NO grants (unrestricted) OR the user is
 * an administrator OR at least one of its grants matches the user. Returns the
 * accessible ids as TEXT (the storage form); compare with `resourceIdText(id)`.
 */
export async function filterAccessibleResourceIds(
  userId: number,
  resourceType: ResourceGrantType,
  resourceIds: Array<number | string>
): Promise<Set<string>> {
  const idTexts = resourceIds.map(resourceIdText);
  const accessible = new Set<string>();
  if (idTexts.length === 0) return accessible;

  const validUser = Number.isInteger(userId) && userId > 0;
  // Parameterized IN-list (drizzle does NOT expand a raw array into an IN list).
  const idList = sql.join(
    idTexts.map((t) => sql`${t}`),
    sql`, `
  );

  // Administrators see everything — short-circuit before any grant lookup.
  if (validUser) {
    const adminResult = await executeQuery(
      (db) =>
        db.execute(sql`
          SELECT EXISTS (
            SELECT 1 FROM user_roles ur
              JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = ${userId}
               AND lower(r.name) = 'administrator'
          ) AS is_admin
        `),
      "filterAccessibleResourceIds.admin"
    );
    const [adminRow] = toPgRows<{ is_admin: boolean }>(adminResult);
    if (adminRow?.is_admin === true) {
      for (const id of idTexts) accessible.add(id);
      return accessible;
    }
  }

  // For each CANDIDATE that has grants, decide whether the user matches any.
  // Candidates absent from this result have no grants → unrestricted.
  const matchResult = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT
          g.resource_id AS resource_id,
          bool_or(
            (g.grant_kind = 'role' AND ${validUser} AND EXISTS (
              SELECT 1 FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
               WHERE ur.user_id = ${userId}
                 AND lower(r.name) = lower(g.grant_value)
            ))
            OR
            (g.grant_kind = 'group' AND ${validUser} AND EXISTS (
              SELECT 1 FROM groups grp
                JOIN group_members gm ON gm.group_id = grp.id
                JOIN users u ON lower(u.email) = lower(gm.member_email)
               WHERE grp.is_active = true
                 AND lower(grp.group_email) = lower(g.grant_value)
                 AND u.id = ${userId}
            ))
          ) AS matched
        FROM resource_access_grants g
        WHERE g.resource_type = ${resourceType}
          AND g.resource_id IN (${idList})
        GROUP BY g.resource_id
      `),
    "filterAccessibleResourceIds.match"
  );

  const restricted = new Map<string, boolean>();
  for (const row of toPgRows<{ resource_id: string; matched: boolean }>(matchResult)) {
    restricted.set(row.resource_id, row.matched === true);
  }

  for (const id of idTexts) {
    if (!restricted.has(id)) {
      // No grants for this resource → unrestricted.
      accessible.add(id);
    } else if (restricted.get(id) === true) {
      accessible.add(id);
    }
  }
  return accessible;
}

// ============================================
// Grant management (admin-only in this phase)
// ============================================

/** List a resource's grants (role grants first, then group, each by value). */
export async function listResourceGrants(
  resourceType: ResourceGrantType,
  resourceId: number | string
): Promise<ResourceGrant[]> {
  const idText = resourceIdText(resourceId);
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          grantKind: resourceAccessGrants.grantKind,
          grantValue: resourceAccessGrants.grantValue,
        })
        .from(resourceAccessGrants)
        .where(
          and(
            eq(resourceAccessGrants.resourceType, resourceType),
            eq(resourceAccessGrants.resourceId, idText)
          )
        )
        .orderBy(resourceAccessGrants.grantKind, resourceAccessGrants.grantValue),
    "listResourceGrants"
  );
  return rows;
}

/**
 * Normalize + de-duplicate a submitted grant set. Group emails are lowercased
 * (normalizeEmail); role names are trimmed (kept as-is — matched
 * case-insensitively downstream). Blank values are dropped. Duplicate
 * (kind,value) pairs collapse. Pure — exported for unit tests.
 */
export function normalizeGrants(grants: ResourceGrant[]): ResourceGrant[] {
  const seen = new Set<string>();
  const out: ResourceGrant[] = [];
  for (const g of grants) {
    const value =
      g.grantKind === "group" ? normalizeEmail(g.grantValue) : g.grantValue.trim();
    if (!value) continue;
    const key = `${g.grantKind}:${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ grantKind: g.grantKind, grantValue: value });
  }
  return out;
}

/**
 * Replace ALL of a resource's grants with the given set, atomically
 * (delete-then-insert in one transaction — mirrors the Atrium visibility-grant
 * writer). An empty set clears every grant (the resource becomes unrestricted).
 * Normalizes + de-dupes first; `onConflictDoNothing` guards the unique index
 * against any residual duplicate.
 */
export async function replaceResourceGrants(
  resourceType: ResourceGrantType,
  resourceId: number | string,
  grants: ResourceGrant[],
  createdBy: number | null
): Promise<void> {
  const idText = resourceIdText(resourceId);
  const normalized = normalizeGrants(grants);

  await executeQuery(
    (db) =>
      db.transaction(async (tx: DbTransaction) => {
        await tx
          .delete(resourceAccessGrants)
          .where(
            and(
              eq(resourceAccessGrants.resourceType, resourceType),
              eq(resourceAccessGrants.resourceId, idText)
            )
          );
        if (normalized.length > 0) {
          await tx
            .insert(resourceAccessGrants)
            .values(
              normalized.map((g) => ({
                resourceType,
                resourceId: idText,
                grantKind: g.grantKind,
                grantValue: g.grantValue,
                createdBy: createdBy ?? null,
              }))
            )
            .onConflictDoNothing({
              target: [
                resourceAccessGrants.resourceType,
                resourceAccessGrants.resourceId,
                resourceAccessGrants.grantKind,
                resourceAccessGrants.grantValue,
              ],
            });
        }
      }),
    "replaceResourceGrants"
  );
}

/**
 * Delete every grant for a resource (used when the resource itself is deleted, so
 * no orphan grants linger and get re-used if the serial id is recycled).
 */
export async function deleteAllResourceGrants(
  resourceType: ResourceGrantType,
  resourceId: number | string
): Promise<void> {
  const idText = resourceIdText(resourceId);
  await executeQuery(
    (db) =>
      db
        .delete(resourceAccessGrants)
        .where(
          and(
            eq(resourceAccessGrants.resourceType, resourceType),
            eq(resourceAccessGrants.resourceId, idText)
          )
        ),
    "deleteAllResourceGrants"
  );
}

/**
 * List every resource id of a type that carries the given group grant — the
 * reverse lookup used when a group is de-selected/removed (housekeeping) and by
 * admin surfaces that show "what does this group unlock". `inArray`-free single
 * scan on the lookup index.
 */
export async function listResourceIdsWithGroupGrant(
  resourceType: ResourceGrantType,
  groupEmail: string
): Promise<string[]> {
  const email = normalizeEmail(groupEmail);
  if (!email) return [];
  const rows = await executeQuery(
    (db) =>
      db
        .selectDistinct({ resourceId: resourceAccessGrants.resourceId })
        .from(resourceAccessGrants)
        .where(
          and(
            eq(resourceAccessGrants.resourceType, resourceType),
            eq(resourceAccessGrants.grantKind, "group"),
            eq(sql`lower(${resourceAccessGrants.grantValue})`, email)
          )
        ),
    "listResourceIdsWithGroupGrant"
  );
  return rows.map((r) => r.resourceId);
}
