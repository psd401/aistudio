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
  type DbTransaction,
  type DrizzleDB,
} from "@/lib/db/drizzle-client";
import {
  contentObjects,
  contentVisibilityGrants,
} from "@/lib/db/schema";
import { principalOf } from "./helpers";
import { objectSelectFields, rowToObjectDTO } from "./mappers";
import type {
  ContentObjectDTO,
  ListFilter,
  Principal,
  Requester,
  VisibilityGrant,
} from "./types";

/** Upper bound on a `listVisible` tag filter, mirroring the tags column width. */
const MAX_TAG_LENGTH = 100;

/**
 * The SQL form of `canView` for the permission-pushed `listVisible` query. Built
 * once per request from the principal so listing/retrieval never load-then-drop
 * (§12.3). Kept logically equivalent to `visibilityService.canView`.
 */
function buildVisibilitySql(principal: Principal): SQL {
  if (principal.isAdmin) return sql`true`;

  const o = contentObjects;
  const userIdText = principal.userId != null ? String(principal.userId) : null;
  const roleList = principal.roles;
  const gradeList = principal.gradeLevels ?? [];

  const authenticated = userIdText != null || roleList.length > 0;
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
   * requester's principal. The SQL form below (`listVisible`) must stay logically
   * equivalent so list/retrieval never leak.
   */
  async canView(req: Requester, obj: ViewableObject): Promise<boolean> {
    if (obj.visibilityLevel === "public") return true;

    const principal = principalOf(req);
    // Unauthenticated (no user, no roles) can only ever see public.
    if (principal.userId == null && principal.roles.length === 0) return false;

    if (obj.visibilityLevel === "internal") {
      // Any authenticated principal (a user, or an agent with a role).
      return principal.userId != null || principal.roles.length > 0;
    }
    if (principal.isAdmin) return true;
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
    await tx
      .delete(contentVisibilityGrants)
      .where(eq(contentVisibilityGrants.objectId, objectId));
    if (grants.length > 0) {
      await tx.insert(contentVisibilityGrants).values(
        grants.map((g) => ({
          objectId,
          grantKind: g.kind,
          grantValue: g.value,
        }))
      );
    }
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
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);

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

    return rows.map(rowToObjectDTO);
  },
};
