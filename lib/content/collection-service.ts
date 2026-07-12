/**
 * Atrium collection service
 *
 * Issue #1054 (Epic #1059, Atrium Phase 4). The collection tree IS the intranet
 * section tree. This service loads the collection hierarchy and filters it to the
 * sections a requester may enter — so a user never sees a section they cannot
 * enter (spec §21).
 *
 * ## Visibility model for a collection (no per-collection grant table exists)
 * Collections carry only `default_visibility_level` (there is no
 * `collection_visibility_grants` table — grants live on objects). A collection is
 * therefore "enterable" by a principal when EITHER:
 *  - the collection's `default_visibility_level` admits the principal at the
 *    LEVEL check (public → everyone; internal → any authenticated principal;
 *    private → admin only; group → cannot be satisfied at the collection level
 *    because collections carry no grants — see below), OR
 *  - the principal can view at least one content object placed in the collection
 *    (its subtree counts too). The visible-object counts are computed by the same
 *    permission-pushed visibility predicate (`buildVisibilitySql`) every other
 *    read path uses, via a per-collection `GROUP BY` aggregate bounded by
 *    collection count (not object count), so a `group`-scoped collection
 *    naturally becomes visible to exactly the principals who can see content
 *    inside it (via the objects' own grants).
 *
 * This keeps the two acceptance guarantees aligned:
 *  - "Published content appears in the collection tree" — a visible object lights
 *    up its collection (and all ancestors).
 *  - "Sidebar is filtered by visibility" — an empty/forbidden section the user
 *    cannot enter (no level access AND no visible object) is pruned entirely.
 *
 * An admin sees every collection (the level check short-circuits on `isAdmin`,
 * mirroring `visibilityService.canView`).
 *
 * See docs/features/atrium-design-spec.md §21.
 */

import { asc, eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentCollections } from "@/lib/db/schema";
import { principalOf } from "./helpers";
import { visibilityService } from "./visibility-service";
import type { Principal, Requester, VisibilityLevel } from "./types";

/** A collection row as loaded for the tree (timestamps not needed here). */
interface CollectionRow {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  defaultVisibilityLevel: VisibilityLevel;
  navItemId: number | null;
  position: number;
}

/** A node in the visibility-filtered collection tree returned to surfaces. */
export interface CollectionTreeNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  defaultVisibilityLevel: VisibilityLevel;
  navItemId: number | null;
  position: number;
  /** Number of objects in THIS collection the requester can view (not subtree). */
  visibleObjectCount: number;
  children: CollectionTreeNode[];
}

/**
 * Whether a principal may enter a collection based on its default visibility
 * LEVEL alone (no object/grant lookup). Mirrors the level rules in
 * `visibilityService.canView`, minus the owner branch (collections have no
 * owner) and the grant branches (collections have no grant table):
 *  - public   → everyone (incl. unauthenticated).
 *  - internal → any authenticated principal (a user id or a role).
 *  - private  → admin only.
 *  - group    → not satisfiable at the collection level (no collection grants);
 *               such a section surfaces only when it contains a visible object.
 *
 * Admin short-circuits to true for every level, matching `canView`.
 */
function levelAdmitsPrincipal(
  principal: Principal,
  level: VisibilityLevel
): boolean {
  if (level === "public") return true;
  if (principal.isAdmin) return true;
  if (level === "internal") {
    return principal.userId != null || principal.roles.length > 0;
  }
  // private / group: not enterable on the level check alone for a non-admin.
  return false;
}

/** Load every collection ordered by (position, name) for a stable tree. */
async function loadAllCollections(): Promise<CollectionRow[]> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          id: contentCollections.id,
          name: contentCollections.name,
          slug: contentCollections.slug,
          parentId: contentCollections.parentId,
          defaultVisibilityLevel: contentCollections.defaultVisibilityLevel,
          navItemId: contentCollections.navItemId,
          position: contentCollections.position,
        })
        .from(contentCollections)
        .orderBy(asc(contentCollections.position), asc(contentCollections.name)),
    "collection.loadAll"
  );
  return rows.map((r) => ({
    ...r,
    defaultVisibilityLevel: r.defaultVisibilityLevel as VisibilityLevel,
  }));
}

/** Index collections by id and by parent id (the child lists), in one pass. */
function indexCollections(collections: CollectionRow[]): {
  byId: Map<string, CollectionRow>;
  childrenOf: Map<string | null, CollectionRow[]>;
} {
  const byId = new Map<string, CollectionRow>();
  const childrenOf = new Map<string | null, CollectionRow[]>();
  for (const c of collections) {
    byId.set(c.id, c);
    const siblings = childrenOf.get(c.parentId) ?? [];
    siblings.push(c);
    childrenOf.set(c.parentId, siblings);
  }
  return { byId, childrenOf };
}

/**
 * The set of collection ids to KEEP: every directly-visible collection (its level
 * admits the principal OR it holds ≥1 visible object) plus every ANCESTOR of one,
 * so the tree stays connected.
 *
 * The ancestor walk stops as soon as it reaches a node already in `keep`: because
 * any node added to `keep` had its full ancestor chain added in the same walk,
 * hitting an already-kept node means every node above it is kept too. That
 * `!keep.has(cursorId)` terminator doubles as the cycle guard (a cycle revisits a
 * kept node and stops), so no per-iteration `seen` set is needed.
 */
function computeKeepSet(
  collections: CollectionRow[],
  byId: Map<string, CollectionRow>,
  principal: Principal,
  visibleCountByCollection: Map<string, number>
): Set<string> {
  const keep = new Set<string>();
  for (const c of collections) {
    const levelOk = levelAdmitsPrincipal(principal, c.defaultVisibilityLevel);
    const hasVisibleObject = (visibleCountByCollection.get(c.id) ?? 0) > 0;
    if (!levelOk && !hasVisibleObject) continue;

    // Directly visible: mark it and every not-yet-kept ancestor KEEP.
    let cursorId: string | null = c.id;
    while (cursorId != null && byId.has(cursorId) && !keep.has(cursorId)) {
      keep.add(cursorId);
      cursorId = byId.get(cursorId)?.parentId ?? null;
    }
  }
  return keep;
}

export const collectionService = {
  /**
   * The display name of a single collection by id, or `null` if it does not
   * exist. Used for the Meridian editor breadcrumb (Epic #1059 slice C) — a
   * section LABEL, not sensitive content, and only ever shown for an object the
   * caller has already been cleared to view. Returns `null` for a `null` id so
   * callers can pass `obj.collectionId` straight through.
   */
  async nameById(collectionId: string | null): Promise<string | null> {
    if (!collectionId) return null;
    const rows = await executeQuery(
      (db) =>
        db
          .select({ name: contentCollections.name })
          .from(contentCollections)
          .where(eq(contentCollections.id, collectionId))
          .limit(1),
      "collection.nameById"
    );
    return rows[0]?.name ?? null;
  },

  /**
   * Build the requester-visible collection tree (the reader sidebar / library
   * section tree). Returns only the collections the requester may enter, with the
   * empty/forbidden subtrees pruned but every ANCESTOR of a visible node kept so
   * the tree stays connected.
   *
   * Algorithm:
   *  1. Load all collections + the requester's visible objects (one permission-
   *     pushed `listVisible`).
   *  2. A collection is "directly visible" if its level admits the principal OR it
   *     holds ≥1 visible object; mark it and its ancestors KEEP.
   *  3. Assemble the kept collections into a parent/child forest.
   */
  async tree(req: Requester): Promise<CollectionTreeNode[]> {
    const principal = principalOf(req);
    const [collections, visibleCountByCollection] = await Promise.all([
      loadAllCollections(),
      // Per-collection visible-object counts (permission-pushed, GROUP BY in SQL).
      // Excludes archived; published + draft both count toward "this section has
      // content I can see". Bounded by collection count, not object count, so a
      // large library never silently prunes a section whose visible objects fall
      // outside a capped list page (the reader sidebar is the same visibility, so
      // a non-author only ever counts published content they're entitled to).
      visibilityService.visibleCountsByCollection(req),
    ]);

    const { byId, childrenOf } = indexCollections(collections);
    const keep = computeKeepSet(
      collections,
      byId,
      principal,
      visibleCountByCollection
    );

    // Build the kept forest. A child is attached only when both it and its parent
    // are kept; ancestor-propagation guarantees a kept node's parent is also kept.
    const build = (parentId: string | null): CollectionTreeNode[] =>
      (childrenOf.get(parentId) ?? [])
        .filter((c) => keep.has(c.id))
        .map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          parentId: c.parentId,
          defaultVisibilityLevel: c.defaultVisibilityLevel,
          navItemId: c.navItemId,
          position: c.position,
          visibleObjectCount: visibleCountByCollection.get(c.id) ?? 0,
          children: build(c.id),
        }));

    return build(null);
  },
};
