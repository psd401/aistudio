/**
 * Atrium collection access resolver (#1438).
 *
 * Collection ACLs are an additional boundary around object visibility:
 * object visibility decides whether the requester may consume an object, while
 * this module decides whether its containing collection admits that requester.
 * Owner-bound private collections admit only their owner and never inherit
 * grants. Administrators can inspect their metadata through the management
 * service, but that district oversight never grants access to private contents.
 * District/shared grants use
 * "zero rows = unrestricted"; when rows exist, any matching role/group/org/user
 * grant admits the requester. `inheritGrants=false` cuts off the ancestor walk.
 */

import { asc } from "drizzle-orm";
import {
  executeQuery,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import {
  contentCollectionGrants,
  contentCollections,
} from "@/lib/db/schema";
import { principalOf } from "./helpers";
import type {
  CollectionGrant,
  CollectionGrantAccess,
  Principal,
  Requester,
  VisibilityLevel,
} from "./types";

export interface CollectionAccessRow {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  ownerUserId: number | null;
  defaultVisibilityLevel: VisibilityLevel;
  inheritGrants: boolean;
  position: number;
  archivedAt: Date | null;
  /** Section hero copy (migration 175); null for sections that predate it. */
  description: string | null;
  /** Pinned "start here" object for the section landing page, or null. */
  landingObjectId: string | null;
  /** Section hero image S3 key (migration 178), or null. */
  heroImageKey: string | null;
  /** Alt text for the hero image; null whenever there is no image. */
  heroImageAlt: string | null;
  /** Publishing out of this collection needs approval (migration 178). */
  requiresApproval: boolean;
}

export interface CollectionAccessSnapshot {
  collections: CollectionAccessRow[];
  byId: Map<string, CollectionAccessRow>;
  directGrants: Map<string, CollectionGrant[]>;
  effectiveGrants: (
    collectionId: string,
    access: CollectionGrantAccess
  ) => CollectionGrant[];
  allowedCollectionIds: Set<string>;
  selectableCollectionIds: Set<string>;
}

/** A human identity that can own an owner-bound private collection. */
export function collectionOwnerUserId(req: Requester): number | null {
  if (req.kind === "user") return req.userId;
  if (req.kind === "agent-delegated") return req.actingForUserId;
  return null;
}

export function principalMatchesCollectionGrant(
  principal: Principal,
  grant: CollectionGrant
): boolean {
  switch (grant.kind) {
    case "role":
      return principal.roles.includes(grant.value);
    case "building":
      return principal.building === grant.value;
    case "department":
      return principal.department === grant.value;
    case "grade":
      return (principal.gradeLevels ?? []).includes(grant.value);
    case "user":
      return (
        principal.userId != null && String(principal.userId) === grant.value
      );
    case "group":
      return principal.groups.includes(grant.value.toLowerCase());
  }
}

/**
 * May this requester approve a publish out of `collection`?
 *
 * Only consulted for a collection with `requiresApproval` set. Three ways in,
 * and the first two are implicit on purpose: a gated collection must never be
 * able to reach a state where nobody can clear its queue, which is exactly what
 * happens if the only approvers are an explicit roster that is later emptied,
 * or whose members leave the district.
 *
 *  1. District administrators — the existing /admin/atrium approvers.
 *  2. The collection's owner, for a personal collection.
 *  3. Anyone matching an `approve` grant on the collection.
 *
 * Grant INHERITANCE follows the same rule as view/create: a district collection
 * inherits approvers from its ancestors while `inheritGrants` holds, and a
 * personal collection never inherits (its grants are read directly). This
 * matters for the intranet, where sub-sections should be approvable by the
 * people who approve their parent without re-listing them on every child.
 *
 * An `approve` grant confers NO view or create access — `effectiveGrantResolver`
 * matches on exact access — so naming an approver does not hand them the
 * contents.
 */
export function isCollectionApprover(
  req: Requester,
  collection: CollectionAccessRow,
  access: Pick<CollectionAccessSnapshot, "effectiveGrants" | "directGrants">
): boolean {
  const principal = principalOf(req);
  if (principal.isAdmin) return true;
  if (
    collection.ownerUserId != null &&
    collectionOwnerUserId(req) === collection.ownerUserId
  ) {
    return true;
  }
  const approveGrants =
    collection.ownerUserId == null
      ? access.effectiveGrants(collection.id, "approve")
      : (access.directGrants.get(collection.id) ?? []).filter(
          (grant) => grant.access === "approve"
        );
  return approveGrants.some((grant) =>
    principalMatchesCollectionGrant(principal, grant)
  );
}

async function loadRows(): Promise<{
  collections: CollectionAccessRow[];
  directGrants: Map<string, CollectionGrant[]>;
}> {
  const [collectionRows, grantRows] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select({
            id: contentCollections.id,
            name: contentCollections.name,
            slug: contentCollections.slug,
            parentId: contentCollections.parentId,
            ownerUserId: contentCollections.ownerUserId,
            defaultVisibilityLevel:
              contentCollections.defaultVisibilityLevel,
            inheritGrants: contentCollections.inheritGrants,
            position: contentCollections.position,
            archivedAt: contentCollections.archivedAt,
            description: contentCollections.description,
            landingObjectId: contentCollections.landingObjectId,
            heroImageKey: contentCollections.heroImageKey,
            heroImageAlt: contentCollections.heroImageAlt,
            requiresApproval: contentCollections.requiresApproval,
          })
          .from(contentCollections)
          .orderBy(
            asc(contentCollections.position),
            asc(contentCollections.name)
          ),
      "collectionAccess.loadCollections"
    ),
    executeQuery(
      (db) =>
        db
          .select({
            collectionId: contentCollectionGrants.collectionId,
            access: contentCollectionGrants.access,
            kind: contentCollectionGrants.grantKind,
            value: contentCollectionGrants.grantValue,
          })
          .from(contentCollectionGrants),
      "collectionAccess.loadGrants"
    ),
  ]);

  const directGrants = new Map<string, CollectionGrant[]>();
  for (const row of grantRows) {
    const grants = directGrants.get(row.collectionId) ?? [];
    grants.push({
      access: row.access,
      kind: row.kind,
      value: row.value,
    });
    directGrants.set(row.collectionId, grants);
  }

  return {
    collections: collectionRows.map((row) => ({
      ...row,
      defaultVisibilityLevel: row.defaultVisibilityLevel as VisibilityLevel,
    })),
    directGrants,
  };
}

async function loadRowsInTx(tx: DbTransaction): Promise<{
  collections: CollectionAccessRow[];
  directGrants: Map<string, CollectionGrant[]>;
}> {
  // Collection-management mutations take FOR UPDATE locks on the same rows
  // before changing lifecycle, hierarchy, defaults, or grants. Holding SHARE
  // locks through the caller's content transaction therefore makes placement
  // authorization and the object INSERT/UPDATE one serializable operation.
  const collectionRows = await tx
    .select({
      id: contentCollections.id,
      name: contentCollections.name,
      slug: contentCollections.slug,
      parentId: contentCollections.parentId,
      ownerUserId: contentCollections.ownerUserId,
      defaultVisibilityLevel: contentCollections.defaultVisibilityLevel,
      inheritGrants: contentCollections.inheritGrants,
      position: contentCollections.position,
      archivedAt: contentCollections.archivedAt,
      description: contentCollections.description,
      landingObjectId: contentCollections.landingObjectId,
      heroImageKey: contentCollections.heroImageKey,
      heroImageAlt: contentCollections.heroImageAlt,
      requiresApproval: contentCollections.requiresApproval,
    })
    .from(contentCollections)
    .orderBy(
      asc(contentCollections.position),
      asc(contentCollections.name)
    )
    .for("share");
  const grantRows = await tx
    .select({
      collectionId: contentCollectionGrants.collectionId,
      access: contentCollectionGrants.access,
      kind: contentCollectionGrants.grantKind,
      value: contentCollectionGrants.grantValue,
    })
    .from(contentCollectionGrants);

  const directGrants = new Map<string, CollectionGrant[]>();
  for (const row of grantRows) {
    const grants = directGrants.get(row.collectionId) ?? [];
    grants.push({
      access: row.access,
      kind: row.kind,
      value: row.value,
    });
    directGrants.set(row.collectionId, grants);
  }

  return {
    collections: collectionRows.map((row) => ({
      ...row,
      defaultVisibilityLevel: row.defaultVisibilityLevel as VisibilityLevel,
    })),
    directGrants,
  };
}

function effectiveGrantResolver(
  byId: Map<string, CollectionAccessRow>,
  directGrants: Map<string, CollectionGrant[]>
): CollectionAccessSnapshot["effectiveGrants"] {
  const cache = new Map<string, CollectionGrant[]>();
  return (collectionId, access) => {
    const cacheKey = `${collectionId}:${access}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const result: CollectionGrant[] = [];
    const seen = new Set<string>();
    let cursor: string | null = collectionId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const row = byId.get(cursor);
      if (!row || row.ownerUserId != null) break;
      result.push(
        ...(directGrants.get(cursor) ?? []).filter(
          (grant) => grant.access === access
        )
      );
      if (!row.inheritGrants) break;
      cursor = row.parentId;
    }

    const deduped = [
      ...new Map(
        result.map((grant) => [
          `${grant.access}:${grant.kind}:${grant.value}`,
          grant,
        ])
      ).values(),
    ];
    cache.set(cacheKey, deduped);
    return deduped;
  };
}

/**
 * Resolve active collection access for one requester.
 *
 * Archived collections are deliberately excluded from both sets: archiving a
 * collection hides its contents without deleting them; restoring the collection
 * makes the same objects reachable again. Management queries use the raw rows.
 */
export async function collectionAccessSnapshot(
  req: Requester
): Promise<CollectionAccessSnapshot> {
  const { collections, directGrants } = await loadRows();
  return accessSnapshotFromRows(req, collections, directGrants);
}

/**
 * Resolve collection access while holding collection SHARE locks until the
 * caller's transaction commits. Content create/move paths use this variant so
 * an archive, grant revocation, or default change cannot land between the
 * authorization decision and the object write.
 */
export async function collectionAccessSnapshotInTx(
  tx: DbTransaction,
  req: Requester
): Promise<CollectionAccessSnapshot> {
  const { collections, directGrants } = await loadRowsInTx(tx);
  return accessSnapshotFromRows(req, collections, directGrants);
}

/**
 * Access to ONE owner-bound (personal) collection: its owner always, plus
 * anyone the owner explicitly granted after migration 178 made personal
 * collections shareable.
 *
 * Grants are read from `directGrants`, deliberately NOT `effectiveGrants`. The
 * no-inheritance rule for personal trees then holds STRUCTURALLY rather than by
 * convention, so a future change to the inheritance walk cannot quietly start
 * leaking a parent's grants into someone's private tree.
 *
 * The zero-grants case is the OPPOSITE of a district collection's. There, "no
 * view grants" means unrestricted (legacy behaviour). Here it must mean OWNER
 * ONLY — an ungranted personal collection is private by definition, and reusing
 * the district rule would publish every private tree in the district to
 * everyone. `.some()` over an empty array is false, so this fails closed by
 * construction rather than by a guard someone could remove.
 *
 * Administrators are deliberately NOT admitted. Object-level `canView` already
 * gives them the CONTENTS; the collection itself is someone's personal
 * organization of their own work and stays out of everyone else's sidebar.
 * That boundary predates sharing and is unchanged by it.
 */
function personalCollectionAccess(
  collection: CollectionAccessRow,
  principal: Principal,
  ownerUserId: number | null,
  directGrants: Map<string, CollectionGrant[]>
): { mayView: boolean; mayCreate: boolean } {
  if (ownerUserId != null && collection.ownerUserId === ownerUserId) {
    return { mayView: true, mayCreate: true };
  }
  const own = directGrants.get(collection.id) ?? [];
  const matches = (access: CollectionGrantAccess): boolean =>
    own.some(
      (grant) =>
        grant.access === access &&
        principalMatchesCollectionGrant(principal, grant)
    );
  const mayCreate = matches("create");
  // `create` implies `view`: filing into a collection you cannot open is not a
  // state worth representing.
  return { mayView: mayCreate || matches("view"), mayCreate };
}

function accessSnapshotFromRows(
  req: Requester,
  collections: CollectionAccessRow[],
  directGrants: Map<string, CollectionGrant[]>
): CollectionAccessSnapshot {
  const byId = new Map(collections.map((row) => [row.id, row]));
  const effectiveGrants = effectiveGrantResolver(byId, directGrants);
  const principal = principalOf(req);
  const ownerUserId = collectionOwnerUserId(req);
  const allowedCollectionIds = new Set<string>();
  const selectableCollectionIds = new Set<string>();

  for (const collection of collections) {
    if (collection.archivedAt) continue;

    if (collection.ownerUserId != null) {
      const personal = personalCollectionAccess(
        collection,
        principal,
        ownerUserId,
        directGrants
      );
      if (personal.mayView) allowedCollectionIds.add(collection.id);
      if (personal.mayCreate) selectableCollectionIds.add(collection.id);
      continue;
    }

    const viewGrants = effectiveGrants(collection.id, "view");
    const createGrants = effectiveGrants(collection.id, "create");
    if (
      principal.isAdmin ||
      viewGrants.length === 0 ||
      viewGrants.some((grant) =>
        principalMatchesCollectionGrant(principal, grant)
      )
    ) {
      allowedCollectionIds.add(collection.id);
    }
    if (
      principal.isAdmin ||
      (createGrants.length === 0
        ? principal.userId != null || principal.roles.length > 0
        : createGrants.some((grant) =>
            principalMatchesCollectionGrant(principal, grant)
          ))
    ) {
      selectableCollectionIds.add(collection.id);
    }
  }

  return {
    collections,
    byId,
    directGrants,
    effectiveGrants,
    allowedCollectionIds,
    selectableCollectionIds,
  };
}

/**
 * Pure internals exposed for unit tests. `accessSnapshotFromRows` is the whole
 * access decision as a pure function of (requester, rows, grants), so the
 * personal-collection and approver rules can be tested without a database.
 */
export const accessInternals = {
  accessSnapshotFromRows,
  personalCollectionAccess,
};

export async function requesterMayViewCollection(
  req: Requester,
  collectionId: string | null | undefined
): Promise<boolean> {
  if (!collectionId) return true;
  return (await collectionAccessSnapshot(req)).allowedCollectionIds.has(
    collectionId
  );
}

export async function requesterMayCreateInCollection(
  req: Requester,
  collectionId: string
): Promise<boolean> {
  return (await collectionAccessSnapshot(req)).selectableCollectionIds.has(
    collectionId
  );
}
