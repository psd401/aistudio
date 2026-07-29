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
      if (
        (ownerUserId != null && collection.ownerUserId === ownerUserId)
      ) {
        allowedCollectionIds.add(collection.id);
      }
      if (
        ownerUserId != null &&
        collection.ownerUserId === ownerUserId
      ) {
        selectableCollectionIds.add(collection.id);
      }
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
