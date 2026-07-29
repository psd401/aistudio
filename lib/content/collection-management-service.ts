/**
 * Atrium collection mutation and management service (#1438).
 *
 * This is the single write path used by UI actions, REST, and the owner-bound
 * psd-atrium broker. It enforces the district-vs-private authority split,
 * owner-homogeneous private trees, cycle prevention, stable slugs, recursive
 * archive/restore, and atomic grant replacement.
 */

import { count, eq, inArray } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import {
  contentCollectionGrants,
  contentCollections,
  contentObjects,
  users,
} from "@/lib/db/schema";
import {
  assertCanCreate,
  principalOf,
  slugCandidate,
  slugifyTitle,
} from "./helpers";
import {
  collectionAccessSnapshot,
  collectionOwnerUserId,
  type CollectionAccessRow,
} from "./collection-access";
import { recordContentAudit, type ContentAuditSurface } from "./audit";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./errors";
import {
  GRANT_KIND_SET,
  GROUP_EMAIL_RE,
  POSITIVE_INT_RE,
  VISIBILITY_LEVEL_SET,
} from "./validators";
import type {
  CollectionDTO,
  CollectionGrant,
  CollectionScope,
  CreateCollectionInput,
  Requester,
  UpdateCollectionInput,
  VisibilityLevel,
} from "./types";

const NAME_MAX_LENGTH = 200;
const GRANT_VALUE_MAX_LENGTH = 255;
const POSITION_MAX = 2_147_483_647;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface MutationOptions {
  surface?: ContentAuditSurface;
  requestId?: string;
}

function normalizedName(name: string): string {
  const value = name.trim();
  if (!value) throw new ValidationError("Collection name is required");
  if (value.length > NAME_MAX_LENGTH) {
    throw new ValidationError(
      `Collection name must be ${NAME_MAX_LENGTH} characters or fewer`
    );
  }
  return value;
}

function normalizedPosition(position: number | undefined): number | undefined {
  if (position === undefined) return undefined;
  if (
    !Number.isInteger(position) ||
    position < 0 ||
    position > POSITION_MAX
  ) {
    throw new ValidationError("Collection position must be a non-negative integer");
  }
  return position;
}

function assertCollectionId(collectionId: string): void {
  if (!UUID_RE.test(collectionId)) {
    throw new ValidationError("Collection id must be a valid UUID", {
      collectionId,
    });
  }
}

function normalizeGrants(grants: CollectionGrant[]): CollectionGrant[] {
  const normalized = grants.map((grant) => {
    if (grant.access !== "view" && grant.access !== "create") {
      throw new ValidationError("Invalid collection grant access", {
        access: grant.access,
      });
    }
    if (!GRANT_KIND_SET.has(grant.kind)) {
      throw new ValidationError("Invalid collection grant kind", {
        kind: grant.kind,
      });
    }
    const value =
      grant.kind === "group"
        ? grant.value.trim().toLowerCase()
        : grant.value.trim();
    if (!value || value.length > GRANT_VALUE_MAX_LENGTH) {
      throw new ValidationError("Invalid collection grant value", {
        kind: grant.kind,
      });
    }
    if (grant.kind === "user" && !POSITIVE_INT_RE.test(value)) {
      throw new ValidationError(
        "A user collection grant requires a positive-integer user id"
      );
    }
    if (grant.kind === "group" && !GROUP_EMAIL_RE.test(value)) {
      throw new ValidationError(
        "A group collection grant requires a group email"
      );
    }
    return { ...grant, value };
  });

  return [
    ...new Map(
      normalized.map((grant) => [
        `${grant.access}:${grant.kind}:${grant.value}`,
        grant,
      ])
    ).values(),
  ];
}

function assertVisibilityLevel(level: VisibilityLevel): void {
  if (!VISIBILITY_LEVEL_SET.has(level)) {
    throw new ValidationError("Invalid collection default visibility", {
      level,
    });
  }
}

function scopeOf(row: CollectionAccessRow): CollectionScope {
  return row.ownerUserId == null ? "district" : "private";
}

function assertMayManage(req: Requester, row: CollectionAccessRow): void {
  const principal = principalOf(req);
  if (row.ownerUserId == null) {
    if (!principal.isAdmin) {
      throw new ForbiddenError(
        "Administrator authority is required to manage district collections"
      );
    }
    return;
  }
  if (collectionOwnerUserId(req) !== row.ownerUserId) {
    if (!principal.isAdmin) {
      throw new NotFoundError("Collection not found");
    }
    throw new ForbiddenError("You may manage only private collections you own");
  }
  if (req.kind !== "user" && !req.scopes.includes("content:update")) {
    throw new ForbiddenError("content:update scope required");
  }
}

function assertMayCreateScope(req: Requester, scope: CollectionScope): number | null {
  assertCanCreate(req);
  const principal = principalOf(req);
  if (scope === "district") {
    if (!principal.isAdmin) {
      throw new ForbiddenError(
        "Administrator authority is required to create district collections"
      );
    }
    return null;
  }
  const ownerUserId = collectionOwnerUserId(req);
  if (ownerUserId == null) {
    throw new ForbiddenError(
      "A human owner is required to create a private collection"
    );
  }
  return ownerUserId;
}

function assertParent(
  byId: Map<string, CollectionAccessRow>,
  parentId: string | null,
  scope: CollectionScope,
  ownerUserId: number | null
): CollectionAccessRow | null {
  if (!parentId) return null;
  const parent = byId.get(parentId);
  if (!parent) throw new ValidationError("Parent collection not found", { parentId });
  if (parent.archivedAt) {
    throw new ValidationError("An archived collection cannot be a parent", {
      parentId,
    });
  }
  if (scopeOf(parent) !== scope) {
    throw new ValidationError(
      "Private and district collections cannot be mixed in one hierarchy"
    );
  }
  if (scope === "private" && parent.ownerUserId !== ownerUserId) {
    throw new ValidationError("Parent collection not found", { parentId });
  }
  return parent;
}

function assertNoCycle(
  byId: Map<string, CollectionAccessRow>,
  collectionId: string,
  parentId: string | null
): void {
  const seen = new Set<string>([collectionId]);
  let cursor = parentId;
  while (cursor) {
    if (seen.has(cursor)) {
      throw new ValidationError("Collection hierarchy cannot contain a cycle", {
        collectionId,
        parentId,
      });
    }
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
}

function assertSiblingNameAvailable(
  rows: CollectionAccessRow[],
  name: string,
  parentId: string | null,
  ownerUserId: number | null,
  ignoreId?: string
): void {
  const folded = name.toLowerCase();
  const conflict = rows.some(
    (row) =>
      row.id !== ignoreId &&
      row.parentId === parentId &&
      row.ownerUserId === ownerUserId &&
      row.name.toLowerCase() === folded
  );
  if (conflict) {
    throw new ConflictError(
      "A collection with this name already exists under the selected parent",
      { name, parentId }
    );
  }
}

function nextSlug(
  rows: CollectionAccessRow[],
  name: string,
  ownerUserId: number | null
): string {
  const nameSlug = slugifyTitle(name);
  // Private slugs are owner-namespaced so another user's hidden collection name
  // cannot be inferred from an otherwise surprising global collision suffix.
  const unboundedBase =
    ownerUserId == null ? nameSlug : `private-${ownerUserId}-${nameSlug}`;
  // `slugifyTitle` bounds the name part, but a private owner prefix can push the
  // combined value past content_collections.slug's varchar(200) limit.
  const base = unboundedBase
    .slice(0, NAME_MAX_LENGTH)
    .replace(/-+$/g, "");
  const taken = new Set(rows.map((row) => row.slug));
  for (let attempt = 0; attempt <= taken.size; attempt++) {
    const candidate = slugCandidate(base, attempt);
    if (!taken.has(candidate)) return candidate;
  }
  throw new ConflictError("Could not allocate a collection slug", { base });
}

function nextPosition(
  rows: CollectionAccessRow[],
  parentId: string | null
): number {
  const siblings = rows.filter((row) => row.parentId === parentId);
  const highest = siblings.reduce(
    (value, row) => Math.max(value, row.position),
    -1
  );
  if (highest < POSITION_MAX) return highest + 1;

  // An explicitly positioned sibling may already occupy PostgreSQL's int4 max.
  // Reuse the first non-negative gap instead of overflowing to 2147483648.
  const used = new Set(siblings.map((row) => row.position));
  const fallbackLimit = Math.min(siblings.length, POSITION_MAX);
  for (let candidate = 0; candidate <= fallbackLimit; candidate++) {
    if (!used.has(candidate)) return candidate;
  }
  throw new ConflictError("Collection position space is exhausted", {
    parentId,
  });
}

async function replaceGrants(
  tx: DbTransaction,
  collectionId: string,
  grants: CollectionGrant[]
): Promise<void> {
  await tx
    .delete(contentCollectionGrants)
    .where(eq(contentCollectionGrants.collectionId, collectionId));
  if (grants.length === 0) return;
  await tx.insert(contentCollectionGrants).values(
    grants.map((grant) => ({
      collectionId,
      access: grant.access,
      grantKind: grant.kind,
      grantValue: grant.value,
    }))
  );
}

function descendantIds(
  rows: CollectionAccessRow[],
  rootId: string
): string[] {
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const ids = children.get(row.parentId) ?? [];
    ids.push(row.id);
    children.set(row.parentId, ids);
  }
  const result: string[] = [];
  const pending = [rootId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    pending.push(...(children.get(id) ?? []));
  }
  return result;
}

/**
 * Pure hierarchy helpers exposed for focused regression tests. The mutation
 * service remains the only production write surface.
 */
export const collectionManagementInternals = {
  assertCollectionId,
  assertMayCreateScope,
  assertMayManage,
  assertParent,
  assertNoCycle,
  assertSiblingNameAvailable,
  descendantIds,
  nextPosition,
  nextSlug,
  normalizeGrants,
};

async function auditCollectionMutation(input: {
  req: Requester;
  action:
    | "collection_create"
    | "collection_update"
    | "collection_archive"
    | "collection_restore";
  collectionId?: string;
  collectionName?: string;
  collectionScope?: CollectionScope;
  parentId?: string | null;
  outcome: "ok" | "error";
  error?: unknown;
  options?: MutationOptions;
}): Promise<void> {
  await recordContentAudit({
    req: input.req,
    action: input.action,
    surface: input.options?.surface ?? "ui",
    objectId: null,
    outcome: input.outcome,
    error:
      input.error instanceof Error
        ? input.error.message
        : input.error
          ? String(input.error)
          : null,
    details: {
      collectionId: input.collectionId,
      collectionName: input.collectionName,
      collectionScope: input.collectionScope,
      parentId: input.parentId ?? null,
    },
    requestId: input.options?.requestId ?? null,
  });
}

async function managementDTOs(req: Requester): Promise<CollectionDTO[]> {
  const access = await collectionAccessSnapshot(req);
  const [contentCounts, ownerRows] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select({
            collectionId: contentObjects.collectionId,
            count: count(),
          })
          .from(contentObjects)
          .groupBy(contentObjects.collectionId),
      "collectionManagement.contentCounts"
    ),
    executeQuery(
      (db) =>
        db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(users),
      "collectionManagement.ownerNames"
    ),
  ]);
  const directCounts = new Map(
    contentCounts
      .filter((row) => row.collectionId != null)
      .map((row) => [row.collectionId as string, Number(row.count)])
  );
  const ownerNames = new Map(
    ownerRows.map((row) => {
      const full = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
      return [row.id, full || row.email || `User #${row.id}`];
    })
  );
  const children = new Map<string | null, string[]>();
  for (const row of access.collections) {
    const ids = children.get(row.parentId) ?? [];
    ids.push(row.id);
    children.set(row.parentId, ids);
  }
  const subtreeCache = new Map<string, number>();
  const subtreeCount = (id: string, active = new Set<string>()): number => {
    const cached = subtreeCache.get(id);
    if (cached != null) return cached;
    if (active.has(id)) return directCounts.get(id) ?? 0;
    const next = new Set(active);
    next.add(id);
    const value =
      (directCounts.get(id) ?? 0) +
      (children.get(id) ?? []).reduce(
        (total, childId) => total + subtreeCount(childId, next),
        0
      );
    subtreeCache.set(id, value);
    return value;
  };
  const pathFor = (id: string): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const row = access.byId.get(cursor);
      if (!row) break;
      path.unshift(row.name);
      cursor = row.parentId;
    }
    return path;
  };

  return access.collections.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    parentId: row.parentId,
    path: pathFor(row.id),
    scope: scopeOf(row),
    ownerUserId: row.ownerUserId,
    ownerName:
      row.ownerUserId == null ? null : ownerNames.get(row.ownerUserId) ?? null,
    defaultVisibilityLevel: row.defaultVisibilityLevel,
    inheritGrants: row.inheritGrants,
    position: row.position,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    directContentCount: directCounts.get(row.id) ?? 0,
    subtreeContentCount: subtreeCount(row.id),
    grants: access.directGrants.get(row.id) ?? [],
    selectableForCreate: access.selectableCollectionIds.has(row.id),
  }));
}

interface NormalizedCollectionUpdate {
  name?: string;
  position?: number;
  grants?: CollectionGrant[];
}

interface CollectionUpdateAuditContext {
  name?: string;
  scope?: CollectionScope;
  parentId?: string | null;
}

interface CollectionUpdateTxInput {
  req: Requester;
  collectionId: string;
  input: UpdateCollectionInput;
  normalized: NormalizedCollectionUpdate;
  audit: CollectionUpdateAuditContext;
}

async function loadCollectionRows(
  tx: DbTransaction
): Promise<CollectionAccessRow[]> {
  return (await tx
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
    .from(contentCollections)) as CollectionAccessRow[];
}

function assertRestorableBelowParent(
  input: UpdateCollectionInput,
  parentId: string | null,
  byId: Map<string, CollectionAccessRow>
): void {
  if (input.archived === false && parentId && byId.get(parentId)?.archivedAt) {
    throw new ValidationError(
      "Restore the parent collection before restoring this collection"
    );
  }
}

function assertPrivateUpdate(
  scope: CollectionScope,
  input: UpdateCollectionInput,
  grants: CollectionGrant[] | undefined
): void {
  if (
    scope === "private" &&
    ((input.defaultVisibilityLevel !== undefined &&
      input.defaultVisibilityLevel !== "private") ||
      input.inheritGrants === true ||
      (grants !== undefined && grants.length > 0))
  ) {
    throw new ValidationError(
      "Private collections must remain private and cannot inherit or carry grants"
    );
  }
}

function collectionUpdateValues(
  input: UpdateCollectionInput,
  normalized: NormalizedCollectionUpdate,
  parentId: string | null
): Partial<typeof contentCollections.$inferInsert> {
  const values: Partial<typeof contentCollections.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (normalized.name !== undefined) values.name = normalized.name;
  if (input.parentId !== undefined) values.parentId = parentId;
  if (normalized.position !== undefined) values.position = normalized.position;
  if (input.defaultVisibilityLevel !== undefined) {
    values.defaultVisibilityLevel = input.defaultVisibilityLevel;
  }
  if (input.inheritGrants !== undefined) {
    values.inheritGrants = input.inheritGrants;
  }
  return values;
}

async function applyArchiveState(
  tx: DbTransaction,
  rows: CollectionAccessRow[],
  collectionId: string,
  archived: boolean | undefined
): Promise<void> {
  if (archived === undefined) return;
  await tx
    .update(contentCollections)
    .set({
      archivedAt: archived ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(inArray(contentCollections.id, descendantIds(rows, collectionId)));
}

async function updateCollectionInTx(
  tx: DbTransaction,
  update: CollectionUpdateTxInput
): Promise<void> {
  const { req, collectionId, input, normalized, audit } = update;
  const rows = await loadCollectionRows(tx);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const existing = byId.get(collectionId);
  if (!existing) {
    throw new NotFoundError("Collection not found", { collectionId });
  }
  assertMayManage(req, existing);
  const scope = scopeOf(existing);
  const parentId =
    input.parentId === undefined ? existing.parentId : input.parentId ?? null;
  audit.name = normalized.name ?? existing.name;
  audit.scope = scope;
  audit.parentId = parentId;

  assertParent(byId, parentId, scope, existing.ownerUserId);
  assertNoCycle(byId, collectionId, parentId);
  assertSiblingNameAvailable(
    rows,
    normalized.name ?? existing.name,
    parentId,
    existing.ownerUserId,
    collectionId
  );
  assertRestorableBelowParent(input, parentId, byId);
  assertPrivateUpdate(scope, input, normalized.grants);

  await tx
    .update(contentCollections)
    .set(collectionUpdateValues(input, normalized, parentId))
    .where(eq(contentCollections.id, collectionId));
  if (normalized.grants !== undefined) {
    await replaceGrants(tx, collectionId, normalized.grants);
  }
  await applyArchiveState(tx, rows, collectionId, input.archived);
}

export const collectionManagementService = {
  async listManageable(req: Requester): Promise<CollectionDTO[]> {
    const rows = await managementDTOs(req);
    const principal = principalOf(req);
    if (principal.isAdmin) return rows;
    const ownerUserId = collectionOwnerUserId(req);
    return rows.filter(
      (row) => row.scope === "private" && row.ownerUserId === ownerUserId
    );
  },

  async listOwnedPrivate(req: Requester): Promise<CollectionDTO[]> {
    const ownerUserId = collectionOwnerUserId(req);
    if (ownerUserId === null) {
      throw new ForbiddenError(
        "A signed-in user is required to manage private collections"
      );
    }
    const rows = await managementDTOs(req);
    return rows.filter(
      (row) => row.scope === "private" && row.ownerUserId === ownerUserId
    );
  },

  async create(
    req: Requester,
    input: CreateCollectionInput,
    options: MutationOptions = {}
  ): Promise<CollectionDTO> {
    const name = normalizedName(input.name);
    const position = normalizedPosition(input.position);
    const ownerUserId = assertMayCreateScope(req, input.scope);
    const level =
      input.scope === "private"
        ? "private"
        : input.defaultVisibilityLevel ?? "internal";
    assertVisibilityLevel(level);
    const inheritGrants =
      input.scope === "private" ? false : input.inheritGrants ?? true;
    const grants = normalizeGrants(input.grants ?? []);
    if (input.scope === "private" && grants.length > 0) {
      throw new ValidationError("Private collections cannot carry access grants");
    }

    let createdId: string | undefined;
    try {
      createdId = await executeTransaction(async (tx) => {
        const rows = (await tx
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
          .from(contentCollections)) as CollectionAccessRow[];
        const byId = new Map(rows.map((row) => [row.id, row]));
        const parentId = input.parentId ?? null;
        assertParent(byId, parentId, input.scope, ownerUserId);
        assertSiblingNameAvailable(rows, name, parentId, ownerUserId);
        const inserted = await tx
          .insert(contentCollections)
          .values({
            name,
            slug: nextSlug(rows, name, ownerUserId),
            parentId,
            ownerUserId,
            defaultVisibilityLevel: level,
            inheritGrants,
            position: position ?? nextPosition(rows, parentId),
          })
          .returning({ id: contentCollections.id });
        if (!inserted[0]) {
          throw new ConflictError("Failed to create collection");
        }
        await replaceGrants(tx, inserted[0].id, grants);
        return inserted[0].id;
      }, "collectionManagement.create", { isolationLevel: "serializable" });
      const created = (await managementDTOs(req)).find(
        (row) => row.id === createdId
      );
      if (!created) throw new NotFoundError("Created collection not found");
      await auditCollectionMutation({
        req,
        action: "collection_create",
        collectionId: created.id,
        collectionName: created.name,
        collectionScope: created.scope,
        parentId: created.parentId,
        outcome: "ok",
        options,
      });
      return created;
    } catch (error) {
      await auditCollectionMutation({
        req,
        action: "collection_create",
        collectionId: createdId,
        collectionName: name,
        collectionScope: input.scope,
        parentId: input.parentId ?? null,
        outcome: "error",
        error,
        options,
      });
      throw error;
    }
  },

  async update(
    req: Requester,
    collectionId: string,
    input: UpdateCollectionInput,
    options: MutationOptions = {}
  ): Promise<CollectionDTO> {
    assertCollectionId(collectionId);
    if (Object.keys(input).length === 0) {
      throw new ValidationError("Nothing to update");
    }
    const name = input.name === undefined ? undefined : normalizedName(input.name);
    const position = normalizedPosition(input.position);
    if (input.defaultVisibilityLevel) {
      assertVisibilityLevel(input.defaultVisibilityLevel);
    }
    const grants =
      input.grants === undefined ? undefined : normalizeGrants(input.grants);
    const auditAction:
      | "collection_update"
      | "collection_archive"
      | "collection_restore" =
      input.archived === true
        ? "collection_archive"
        : input.archived === false
          ? "collection_restore"
          : "collection_update";
    const audit: CollectionUpdateAuditContext = {};

    try {
      await executeTransaction(
        (tx) =>
          updateCollectionInTx(tx, {
            req,
            collectionId,
            input,
            normalized: { name, position, grants },
            audit,
          }),
        "collectionManagement.update",
        { isolationLevel: "serializable" }
      );

      const updated = (await managementDTOs(req)).find(
        (row) => row.id === collectionId
      );
      if (!updated) throw new NotFoundError("Collection not found");
      await auditCollectionMutation({
        req,
        action: auditAction,
        collectionId,
        collectionName: updated.name,
        collectionScope: updated.scope,
        parentId: updated.parentId,
        outcome: "ok",
        options,
      });
      return updated;
    } catch (error) {
      await auditCollectionMutation({
        req,
        action: auditAction,
        collectionId,
        collectionName: audit.name,
        collectionScope: audit.scope,
        parentId: audit.parentId,
        outcome: "error",
        error,
        options,
      });
      throw error;
    }
  },
};
