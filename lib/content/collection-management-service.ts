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
import {
  recordContentAudit,
  recordContentAuditBatch,
  type ContentAuditSurface,
} from "./audit";
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
/**
 * Upper bound on a section description. It is hero copy, not a document — the
 * bound stops an unbounded blob reaching the column and the landing-page hero.
 */
const DESCRIPTION_MAX_LENGTH = 2000;
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

interface GroupDefaultGrantCheck {
  level: VisibilityLevel;
  parentId: string | null;
  inheritGrants: boolean;
  ownGrants: CollectionGrant[];
  byId: Map<string, CollectionAccessRow>;
  directGrants: Map<string, CollectionGrant[]>;
}

function assertGroupDefaultHasEffectiveViewGrant(
  check: GroupDefaultGrantCheck
): void {
  const {
    level,
    parentId,
    inheritGrants,
    ownGrants,
    byId,
    directGrants,
  } = check;
  if (level !== "group") return;
  if (ownGrants.some((grant) => grant.access === "view")) return;

  let cursor = inheritGrants ? parentId : null;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const row = byId.get(cursor);
    if (!row || row.ownerUserId != null) break;
    if (
      (directGrants.get(cursor) ?? []).some(
        (grant) => grant.access === "view"
      )
    ) {
      return;
    }
    if (!row.inheritGrants) break;
    cursor = row.parentId;
  }

  throw new ValidationError(
    "A group-default collection requires at least one effective view grant"
  );
}

interface UpdatedSubtreeGrantCheck {
  rows: CollectionAccessRow[];
  collectionId: string;
  parentId: string | null;
  inheritGrants: boolean;
  level: VisibilityLevel;
  ownGrants: CollectionGrant[];
  directGrants: Map<string, CollectionGrant[]>;
}

function assertUpdatedSubtreeGroupDefaults(
  check: UpdatedSubtreeGrantCheck
): void {
  const existing = check.rows.find((row) => row.id === check.collectionId);
  if (!existing) {
    throw new NotFoundError("Collection not found", {
      collectionId: check.collectionId,
    });
  }
  const byId = new Map(check.rows.map((row) => [row.id, row]));
  byId.set(check.collectionId, {
    ...existing,
    parentId: check.parentId,
    inheritGrants: check.inheritGrants,
    defaultVisibilityLevel: check.level,
  });
  const directGrants = new Map(check.directGrants);
  directGrants.set(check.collectionId, check.ownGrants);

  for (const collectionId of descendantIds(check.rows, check.collectionId)) {
    const row = byId.get(collectionId);
    if (!row) continue;
    assertGroupDefaultHasEffectiveViewGrant({
      level: row.defaultVisibilityLevel,
      parentId: row.parentId,
      inheritGrants: row.inheritGrants,
      ownGrants: directGrants.get(collectionId) ?? [],
      byId,
      directGrants,
    });
  }
}

function scopeOf(row: CollectionAccessRow): CollectionScope {
  return row.ownerUserId == null ? "district" : "private";
}

/**
 * The fields a `create`-grant holder may change on a DISTRICT collection without
 * being an administrator. Strictly the section's landing-page copy: it changes
 * how the section is described, never who can reach it, where it sits, or what
 * visibility its contents inherit.
 *
 * Keep this list minimal and explicit. Anything added here becomes editable by
 * every contributor to the section, so a field that influences access,
 * hierarchy, or lifecycle MUST NOT be added.
 */
const SECTION_EDITOR_FIELDS = new Set([
  "description",
  "landingObjectId",
  // Migration 178. The hero image is section COPY in the same sense the
  // description is — it says what this section is, and the person who
  // contributes to a section is the one who knows. Restructuring the hierarchy
  // still requires an administrator; illustrating your own section does not.
  "heroImageKey",
  "heroImageAlt",
]);

/**
 * Whether a patch touches ONLY the landing-page copy. An empty patch returns
 * false so it can never be treated as a permitted no-op edit.
 */
function isSectionCopyOnlyPatch(input: UpdateCollectionInput): boolean {
  const keys = Object.keys(input);
  return keys.length > 0 && keys.every((key) => SECTION_EDITOR_FIELDS.has(key));
}

function assertMayManage(
  req: Requester,
  row: CollectionAccessRow,
  /**
   * Present only on `update`. When the patch is copy-only AND the caller holds
   * `create` access to this collection, the administrator requirement for a
   * district collection is waived — see SECTION_EDITOR_FIELDS.
   */
  copyOnlyWithCreateAccess = false
): void {
  const principal = principalOf(req);
  if (row.ownerUserId == null) {
    if (!principal.isAdmin && !copyOnlyWithCreateAccess) {
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
  parentId: string | null,
  ownerUserId: number | null
): number {
  const siblings = rows.filter(
    (row) =>
      row.parentId === parentId && row.ownerUserId === ownerUserId
  );
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
interface SiblingMovePlan {
  /** The live sibling group (same parent AND owner) in its new order. */
  order: CollectionAccessRow[];
  /** Rows whose stored position differs from their new index. */
  updates: Array<{ row: CollectionAccessRow; position: number }>;
}

/**
 * Plan moving one collection to `toIndex` within its live sibling group —
 * pure, so the rule is unit-testable without a transaction.
 *
 * The group is resolved HERE, from the rows as they are now: same parent, same
 * owner (a private collection another owner shared into this viewer's tree is
 * not a sibling, whatever the sidebar shows next to it), not archived, in the
 * order the tree displays (position, then name). The moved row is taken out
 * and re-inserted at `toIndex` — the same `arrayMove` semantics as the drag
 * preview — with `toIndex` clamped to the group, and every row is renumbered
 * densely from 0. A sibling that appeared since the tree was loaded simply
 * takes part; the drop never fails for being stale.
 *
 * Throws (the one thing it refuses) when the MOVED row is itself archived —
 * it belongs to no live group, so there is no slot to plan.
 */
function planSiblingMove(
  rows: CollectionAccessRow[],
  moving: CollectionAccessRow,
  toIndex: number
): SiblingMovePlan {
  // The group is the LIVE siblings, and the moved row is one of them. An
  // archived row has no slot among them: splicing it in would give it a
  // position in a group it is not part of and shift every live sibling past
  // it. The sidebar never offers one (archived collections are not in the
  // tree), but `moveCollectionAction` is callable directly.
  if (moving.archivedAt) {
    throw new ValidationError("An archived collection cannot be reordered", {
      collectionId: moving.id,
    });
  }
  const order = rows
    .filter(
      (row) =>
        row.id !== moving.id &&
        row.parentId === moving.parentId &&
        row.ownerUserId === moving.ownerUserId &&
        row.archivedAt === null
    )
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const target = Math.max(0, Math.min(Math.floor(toIndex), order.length));
  order.splice(target, 0, moving);
  const updates = order
    .map((row, position) => ({ row, position }))
    .filter(({ row, position }) => row.position !== position);
  return { order, updates };
}

export const collectionManagementInternals = {
  assertCollectionId,
  planSiblingMove,
  assertGroupDefaultHasEffectiveViewGrant,
  assertUpdatedSubtreeGroupDefaults,
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
    description: row.description,
    landingObjectId: row.landingObjectId,
    heroImageKey: row.heroImageKey,
    heroImageAlt: row.heroImageAlt,
    requiresApproval: row.requiresApproval,
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
  /**
   * Resolved by `update` BEFORE the transaction (it needs the requester's
   * collection-access snapshot): the patch is copy-only and the caller holds
   * `create` access here, so the district-admin requirement is waived.
   */
  copyOnlyWithCreateAccess?: boolean;
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
      // Selected even though the in-transaction validators do not read them:
      // the `as CollectionAccessRow[]` cast below would otherwise assert a
      // shape these rows do not have, and the next reader of a "row" here would
      // silently get `undefined` instead of a type error.
      description: contentCollections.description,
      landingObjectId: contentCollections.landingObjectId,
      heroImageKey: contentCollections.heroImageKey,
      heroImageAlt: contentCollections.heroImageAlt,
      requiresApproval: contentCollections.requiresApproval,
    })
    .from(contentCollections)
    // Content create/move holds SHARE locks on these rows while it authorizes
    // placement. Taking UPDATE locks before any lifecycle/default/grant change
    // closes the corresponding authorization/write race.
    .for("update")) as CollectionAccessRow[];
}

async function loadDirectCollectionGrants(
  tx: DbTransaction
): Promise<Map<string, CollectionGrant[]>> {
  const rows = await tx
    .select({
      collectionId: contentCollectionGrants.collectionId,
      access: contentCollectionGrants.access,
      kind: contentCollectionGrants.grantKind,
      value: contentCollectionGrants.grantValue,
    })
    .from(contentCollectionGrants);
  const directGrants = new Map<string, CollectionGrant[]>();
  for (const row of rows) {
    const grants = directGrants.get(row.collectionId) ?? [];
    grants.push({
      access: row.access,
      kind: row.kind,
      value: row.value,
    });
    directGrants.set(row.collectionId, grants);
  }
  return directGrants;
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

/**
 * The two invariants a personal collection keeps after migration 178 made it
 * shareable.
 *
 * What CHANGED: an owner may now raise their own tree to `group` and attach
 * grants to it. Before, both were rejected here, which is why "share the
 * collection I built" was impossible even though the grants table could
 * express it.
 *
 * What did NOT change:
 *  - It can never default to `internal` or `public`. Those levels mean
 *    "everyone with an account", which is a district collection — if that is
 *    what someone wants, an admin should make one, so it appears in the
 *    district hierarchy and is governed like the rest of it.
 *  - It can never inherit grants. A personal tree's access is exactly what its
 *    owner granted, never something absorbed from an ancestor.
 *
 * The database backstops both (`ck_collection_private_owner_policy`); this is
 * the layer that produces an intelligible message instead of a constraint
 * violation.
 *
 * Note that only the OWNER reaches this code at all — `assertMayManage` throws
 * for everyone else — so a grantee cannot re-share a collection shared with
 * them.
 */
/**
 * The default visibility a personal collection is created at. `private` unless
 * the owner explicitly asked for `group`; anything wider is a hard error, not a
 * silent clamp.
 */
function privateCollectionLevel(
  requested: VisibilityLevel | undefined
): VisibilityLevel {
  if (requested === undefined || requested === "private") return "private";
  if (requested === "group") return "group";
  throw new ValidationError(
    "A personal collection can be private or shared with specific people, but not internal or public"
  );
}

function assertPrivateUpdate(
  scope: CollectionScope,
  input: UpdateCollectionInput
): void {
  if (scope !== "private") return;
  if (
    input.defaultVisibilityLevel !== undefined &&
    input.defaultVisibilityLevel !== "private" &&
    input.defaultVisibilityLevel !== "group"
  ) {
    throw new ValidationError(
      "A personal collection can be private or shared with specific people, but not internal or public"
    );
  }
  if (input.inheritGrants === true) {
    throw new ValidationError(
      "Personal collections cannot inherit grants from a parent"
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
  if (input.requiresApproval !== undefined) {
    values.requiresApproval = input.requiresApproval;
  }
  applySectionCopyValues(input, values);
  return values;
}

/**
 * The section-editor fields (`SECTION_EDITOR_FIELDS`) — description, pinned
 * page, and hero art. Split out of `collectionUpdateValues` so that function
 * stays under the complexity lint; they also happen to be exactly the set a
 * non-admin section editor may patch, so keeping them together is not merely
 * cosmetic.
 *
 * Every one uses `?? null` CLEAR semantics: an explicit `null` from the caller
 * must persist as a cleared column. Passing `undefined` into Drizzle's `.set()`
 * silently drops the column from the UPDATE, so "clear this description" would
 * appear to work and change nothing — see docs/guides/silent-failure-patterns.md.
 */
function applySectionCopyValues(
  input: UpdateCollectionInput,
  values: Partial<typeof contentCollections.$inferInsert>
): void {
  if (input.description !== undefined) {
    const trimmed = input.description?.trim() ?? "";
    values.description = trimmed.length > 0 ? trimmed : null;
  }
  if (input.landingObjectId !== undefined) {
    values.landingObjectId = input.landingObjectId ?? null;
  }
  applyHeroImageValues(input, values);
}

/**
 * The hero-image pair (migration 178), split from `applySectionCopyValues` to
 * keep it under the complexity lint.
 *
 * The two columns are coupled: clearing the KEY must also clear the ALT. Alt
 * text describing an image that is no longer there is worse than none, and
 * leaving it behind would let the next uploaded image silently inherit a
 * description of a completely different picture.
 */
function applyHeroImageValues(
  input: UpdateCollectionInput,
  values: Partial<typeof contentCollections.$inferInsert>
): void {
  const key = input.heroImageKey?.trim() ?? "";
  const clearing = input.heroImageKey !== undefined && key.length === 0;

  if (input.heroImageKey !== undefined) {
    values.heroImageKey = key.length > 0 ? key : null;
  }
  if (clearing) {
    values.heroImageAlt = null;
    return;
  }
  if (input.heroImageAlt !== undefined) {
    const alt = input.heroImageAlt?.trim() ?? "";
    values.heroImageAlt = alt.length > 0 ? alt : null;
  }
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

/**
 * A reparent with no explicit position lands as the LAST sibling of the new
 * group (drag-to-nest and un-nest never send one). Left alone, the row kept
 * its old number and collided with whichever sibling already had it, and the
 * tree's name tie-break decided the order.
 */
function withReparentPosition(
  rows: CollectionAccessRow[],
  existing: CollectionAccessRow,
  input: UpdateCollectionInput,
  normalized: NormalizedCollectionUpdate,
  parentId: string | null
): NormalizedCollectionUpdate {
  const reparenting = input.parentId !== undefined && parentId !== existing.parentId;
  if (!reparenting || normalized.position !== undefined) return normalized;
  return {
    ...normalized,
    position: nextPosition(rows, parentId, existing.ownerUserId),
  };
}

async function updateCollectionInTx(
  tx: DbTransaction,
  update: CollectionUpdateTxInput
): Promise<void> {
  const { req, collectionId, input, normalized, audit } = update;
  const rows = await loadCollectionRows(tx);
  const directGrants = await loadDirectCollectionGrants(tx);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const existing = byId.get(collectionId);
  if (!existing) {
    throw new NotFoundError("Collection not found", { collectionId });
  }
  assertMayManage(req, existing, update.copyOnlyWithCreateAccess ?? false);
  const scope = scopeOf(existing);
  const parentId =
    input.parentId === undefined ? existing.parentId : input.parentId ?? null;
  const positioned = withReparentPosition(rows, existing, input, normalized, parentId);
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
  assertPrivateUpdate(scope, input);
  assertUpdatedSubtreeGroupDefaults({
    rows,
    collectionId,
    level: input.defaultVisibilityLevel ?? existing.defaultVisibilityLevel,
    parentId,
    inheritGrants: input.inheritGrants ?? existing.inheritGrants,
    ownGrants: normalized.grants ?? directGrants.get(collectionId) ?? [],
    directGrants,
  });

  await tx
    .update(contentCollections)
    .set(collectionUpdateValues(input, positioned, parentId))
    .where(eq(contentCollections.id, collectionId));
  // Un-sharing a personal collection CLEARS its grants, even when the caller
  // sent only `defaultVisibilityLevel`.
  //
  // `updateCollectionBodySchema` is `.partial()`, so `{"defaultVisibilityLevel":
  // "private"}` is a legal patch on its own, and `replaceGrants` below runs
  // only when grants were explicitly supplied. Without this the rows would
  // survive the transition — and a later flip back to `group` would silently
  // resurrect a roster the owner believed they had dismantled. (The UI already
  // clears them client-side; this covers REST/MCP and anything added later.)
  //
  // `personalCollectionAccess` independently refuses to honour grants on a
  // `private` collection, so access is already revoked at the read path — this
  // keeps the DATA honest rather than leaving invisible rows behind.
  const unsharingPersonal =
    scope === "private" &&
    input.defaultVisibilityLevel === "private" &&
    existing.defaultVisibilityLevel === "group";

  if (normalized.grants !== undefined) {
    await replaceGrants(tx, collectionId, normalized.grants);
  } else if (unsharingPersonal) {
    await replaceGrants(tx, collectionId, []);
  }
  await applyArchiveState(tx, rows, collectionId, input.archived);
}

export const collectionManagementService = {
  /**
   * Move one collection to `toIndex` among its live siblings (drag-reorder in
   * the sidebar tree). The row is located and `assertMayManage`d FIRST — so a
   * caller who may not see it gets the same masked "Collection not found" as
   * everywhere else, before any structure is consulted — then the group is
   * resolved and renumbered in ONE serializable transaction
   * (`planSiblingMove`, which refuses an archived row: it has no place in a
   * live sibling group). Every renumbered row gets an audit entry, in one
   * batched, best-effort insert.
   */
  async move(
    req: Requester,
    collectionId: string,
    toIndex: number,
    options: MutationOptions = {}
  ): Promise<void> {
    assertCollectionId(collectionId);
    if (!Number.isInteger(toIndex) || toIndex < 0) {
      throw new ValidationError("toIndex must be a non-negative integer");
    }

    let plan: SiblingMovePlan;
    try {
      plan = await executeTransaction(
        async (tx) => {
          const rows = await loadCollectionRows(tx);
          const moving = rows.find((row) => row.id === collectionId);
          if (!moving) {
            throw new NotFoundError("Collection not found", { collectionId });
          }
          assertMayManage(req, moving);
          const next = planSiblingMove(rows, moving, toIndex);
          // Same parent and owner ⇒ the same verdict as `moving`, but asserted
          // per row so the rule never depends on that reasoning staying true.
          for (const { row } of next.updates) assertMayManage(req, row);
          for (const { row, position } of next.updates) {
            await tx
              .update(contentCollections)
              .set({ position, updatedAt: new Date() })
              .where(eq(contentCollections.id, row.id));
          }
          return next;
        },
        "collectionManagement.move",
        { isolationLevel: "serializable" }
      );
    } catch (error) {
      await auditCollectionMutation({
        req,
        action: "collection_update",
        collectionId,
        outcome: "error",
        error,
        options,
      });
      throw error;
    }
    await recordContentAuditBatch(
      plan.updates.map(({ row }) => ({
        req,
        action: "collection_update",
        surface: options.surface ?? "ui",
        objectId: null,
        outcome: "ok",
        details: {
          collectionId: row.id,
          collectionName: row.name,
          collectionScope: scopeOf(row),
          parentId: row.parentId,
        },
        requestId: options.requestId ?? null,
      }))
    );
  },

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
    // A personal collection defaults to `private` but may be created already
    // shared at `group` (migration 178). Any wider level is refused rather than
    // silently downgraded, so "make my collection internal" fails loudly
    // instead of appearing to work — see `assertPrivateUpdate` for why that
    // ceiling exists.
    const level =
      input.scope === "private"
        ? privateCollectionLevel(input.defaultVisibilityLevel)
        : input.defaultVisibilityLevel ?? "internal";
    assertVisibilityLevel(level);
    // Never inherited for a personal tree, regardless of what was asked for.
    const inheritGrants =
      input.scope === "private" ? false : input.inheritGrants ?? true;
    const grants = normalizeGrants(input.grants ?? []);

    let createdId: string | undefined;
    try {
      createdId = await executeTransaction(async (tx) => {
        const rows = await loadCollectionRows(tx);
        const directGrants = await loadDirectCollectionGrants(tx);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const parentId = input.parentId ?? null;
        assertParent(byId, parentId, input.scope, ownerUserId);
        assertSiblingNameAvailable(rows, name, parentId, ownerUserId);
        assertGroupDefaultHasEffectiveViewGrant({
          level,
          parentId,
          inheritGrants,
          ownGrants: grants,
          byId,
          directGrants,
        });
        const inserted = await tx
          .insert(contentCollections)
          .values({
            name,
            slug: nextSlug(rows, name, ownerUserId),
            parentId,
            ownerUserId,
            defaultVisibilityLevel: level,
            inheritGrants,
            position: position ?? nextPosition(rows, parentId, ownerUserId),
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

  /**
   * Cheap "may I edit this section's copy?" pre-flight, for callers that must
   * do expensive work BEFORE they can call `update`.
   *
   * The hero-image action is the motivating case: it has to store bytes (an S3
   * write) or call a paid image model to obtain the key it then patches in.
   * Doing that first and relying on `update`'s own `assertMayManage` to reject
   * afterwards means an unauthorized caller still burns the storage and the
   * generation spend — an authenticated cost-abuse vector against ANY
   * collectionId, including ones that do not exist.
   *
   * Applies the SAME rule as the copy-only carve-out inside `update`
   * (`assertMayManage` + `SECTION_EDITOR_FIELDS`): administrators and district
   * collections, a personal collection's owner, or a non-admin holding `create`
   * access to the section. It is a pre-flight, NOT the authority — `update`
   * re-asserts against the FOR-UPDATE-locked row, so a revocation landing
   * between the two still wins.
   *
   * Returns the collection's CURRENT hero-image key so the caller can delete
   * the superseded object after its replacement is live — see the action.
   */
  async assertMaySetSectionCopy(
    req: Requester,
    collectionId: string
  ): Promise<{ previousHeroImageKey: string | null }> {
    assertCollectionId(collectionId);
    const access = await collectionAccessSnapshot(req);
    const row = access.byId.get(collectionId);
    // Unknown id is a NotFoundError, not a permission error — the same
    // existence-masking `assertMayManage` applies, and it means a caller cannot
    // use this to probe which collection ids exist.
    if (!row) throw new NotFoundError("Collection not found", { collectionId });
    assertMayManage(
      req,
      row,
      access.selectableCollectionIds.has(collectionId)
    );
    return { previousHeroImageKey: row.heroImageKey };
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
    if (
      typeof input.description === "string" &&
      input.description.length > DESCRIPTION_MAX_LENGTH
    ) {
      throw new ValidationError(
        `Description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer`
      );
    }
    if (input.landingObjectId != null) {
      // Same id shape as any other object reference — validated here so a
      // malformed value cannot reach the uuid column as a query error.
      assertCollectionId(input.landingObjectId);
    }
    // A copy-only patch from a non-admin is allowed when they may CREATE in this
    // collection. Resolved here, outside the transaction, because it needs the
    // requester's collection-access snapshot; the decision is then passed in and
    // re-asserted against the locked row inside the tx.
    const principal = principalOf(req);
    const copyOnlyWithCreateAccess =
      !principal.isAdmin &&
      isSectionCopyOnlyPatch(input) &&
      (await collectionAccessSnapshot(req)).selectableCollectionIds.has(
        collectionId
      );
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
            copyOnlyWithCreateAccess,
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
