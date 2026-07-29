/**
 * Atrium collection service
 *
 * Issue #1054 (Epic #1059, Atrium Phase 4). The collection tree IS the intranet
 * section tree. This service loads the collection hierarchy and filters it to the
 * sections a requester may enter — so a user never sees a section they cannot
 * enter (spec §21).
 *
 * Collection ACLs distinguish `view` and `create`, inherit through district
 * parents until `inherit_grants=false`, and form an additional boundary around
 * object visibility. Owner-bound private collections are visible/selectable only
 * to their owner; administrator metadata oversight never grants content access.
 * Zero effective district grants preserve the original default-visibility model.
 * A visible object also keeps its requester-admitted ancestor path in the tree;
 * denied ancestors are omitted and accessible descendants are re-rooted.
 *
 * See docs/features/atrium-design-spec.md §21.
 */

import { eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentCollections } from "@/lib/db/schema";
import { principalOf } from "./helpers";
import { visibilityService } from "./visibility-service";
import {
  collectionAccessSnapshot,
  type CollectionAccessRow,
  type CollectionAccessSnapshot,
} from "./collection-access";
import type {
  CollectionScope,
  Principal,
  Requester,
  VisibilityLevel,
} from "./types";

/** A collection row as loaded for the tree (timestamps not needed here). */
interface CollectionRow extends CollectionAccessRow {
  navItemId: number | null;
}

/** A node in the visibility-filtered collection tree returned to surfaces. */
export interface CollectionTreeNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  scope: CollectionScope;
  ownerUserId: number | null;
  defaultVisibilityLevel: VisibilityLevel;
  navItemId: number | null;
  position: number;
  selectableForCreate: boolean;
  /** Number of objects in THIS collection the requester can view (not subtree). */
  visibleObjectCount: number;
  children: CollectionTreeNode[];
}

/** Public authoring-client projection with display-path and create eligibility. */
export interface CollectionDiscoveryNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  path: string[];
  scope: CollectionScope;
  ownerUserId: number | null;
  defaultVisibilityLevel: VisibilityLevel;
  visibleObjectCount: number;
  /**
   * Present only when the caller also holds `content:create`. Kept at the service
   * boundary so future collection author ACLs can change this decision without
   * changing the external API shape.
   */
  selectableForCreate?: boolean;
  children: CollectionDiscoveryNode[];
}

export type FlatCollectionDiscoveryNode = Omit<
  CollectionDiscoveryNode,
  "children"
>;

function discoveryTree(
  nodes: CollectionTreeNode[],
  parentPath: string[],
  includeCreateSelection: boolean
): CollectionDiscoveryNode[] {
  return nodes.map((node) => {
    const path = [...parentPath, node.name];
    return {
      id: node.id,
      name: node.name,
      slug: node.slug,
      parentId: node.parentId,
      path,
      scope: node.scope,
      ownerUserId: node.ownerUserId,
      defaultVisibilityLevel: node.defaultVisibilityLevel,
      visibleObjectCount: node.visibleObjectCount,
      ...(includeCreateSelection
        ? { selectableForCreate: node.selectableForCreate }
        : {}),
      children: discoveryTree(
        node.children,
        path,
        includeCreateSelection
      ),
    };
  });
}

function flattenDiscoveryTree(
  nodes: CollectionDiscoveryNode[]
): FlatCollectionDiscoveryNode[] {
  const flat: FlatCollectionDiscoveryNode[] = [];
  const visit = (items: CollectionDiscoveryNode[]) => {
    for (const { children, ...node } of items) {
      flat.push(node);
      visit(children);
    }
  };
  visit(nodes);
  return flat;
}

/**
 * Whether a principal may enter a collection based on its default visibility
 * LEVEL alone. This fallback is used only for grant-unrestricted district
 * collections; private ownership and effective collection grants are resolved
 * separately by `collectionAccessSnapshot`:
 *  - public   → everyone (incl. unauthenticated).
 *  - internal → any authenticated principal (a user id or a role).
 *  - private  → admin only.
 *  - group    → not satisfiable at the collection level (no collection grants);
 *               such a section surfaces only when it contains a visible object.
 *
 * Admin short-circuits for district collections; owner-bound private rows never
 * reach this fallback unless the requester is their owner.
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

/** Index collections by id in one pass. */
function indexCollections(
  collections: CollectionRow[]
): Map<string, CollectionRow> {
  const byId = new Map<string, CollectionRow>();
  for (const c of collections) {
    byId.set(c.id, c);
  }
  return byId;
}

/**
 * The set of collection ids to KEEP: every directly-visible collection (its level
 * admits the principal OR it holds ≥1 visible object) plus every requester-
 * admitted ancestor. Denied ancestors are never added merely to preserve the
 * canonical hierarchy; the returned tree compresses across those gaps instead.
 */
function computeKeepSet(
  collections: CollectionRow[],
  byId: Map<string, CollectionRow>,
  principal: Principal,
  visibleCountByCollection: Map<string, number>,
  access: CollectionAccessSnapshot
): Set<string> {
  const keep = new Set<string>();
  for (const c of collections) {
    const allowed = access.allowedCollectionIds.has(c.id);
    const hasViewAcl = access.effectiveGrants(c.id, "view").length > 0;
    const levelOk =
      allowed &&
      (c.ownerUserId != null ||
        hasViewAcl ||
        levelAdmitsPrincipal(principal, c.defaultVisibilityLevel));
    const hasVisibleObject = (visibleCountByCollection.get(c.id) ?? 0) > 0;
    if (!levelOk && !(allowed && hasVisibleObject)) continue;

    // Directly visible: mark it and each admitted ancestor. Keep walking past a
    // denied ancestor so an independently admitted grandparent can still provide
    // context, but never add the denied row itself.
    let cursorId: string | null = c.id;
    const seen = new Set<string>();
    while (cursorId != null && byId.has(cursorId) && !seen.has(cursorId)) {
      seen.add(cursorId);
      if (access.allowedCollectionIds.has(cursorId)) {
        keep.add(cursorId);
      }
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
   * empty/forbidden subtrees pruned. Requester-admitted ancestors of visible
   * nodes are retained; denied ancestors are omitted and descendants re-rooted.
   *
   * Algorithm:
   *  1. Load all collections + the requester's visible objects (one permission-
   *     pushed `listVisible`).
   *  2. A collection is "directly visible" if its level admits the principal OR it
   *     holds ≥1 visible object; mark it and its admitted ancestors KEEP.
   *  3. Assemble the kept collections into a forest, compressing denied gaps.
   */
  async tree(req: Requester): Promise<CollectionTreeNode[]> {
    const principal = principalOf(req);
    const [access, visibleCountByCollection, navRows] = await Promise.all([
      collectionAccessSnapshot(req),
      // Per-collection visible-object counts (permission-pushed, GROUP BY in SQL).
      // Excludes archived; published + draft both count toward "this section has
      // content I can see". Bounded by collection count, not object count, so a
      // large library never silently prunes a section whose visible objects fall
      // outside a capped list page (the reader sidebar is the same visibility, so
      // a non-author only ever counts published content they're entitled to).
      visibilityService.visibleCountsByCollection(req),
      executeQuery(
        (db) =>
          db
            .select({
              id: contentCollections.id,
              navItemId: contentCollections.navItemId,
            })
            .from(contentCollections),
        "collection.loadNavItems"
      ),
    ]);
    const navById = new Map(navRows.map((row) => [row.id, row.navItemId]));
    const collections: CollectionRow[] = access.collections
      .filter((row) => !row.archivedAt)
      .map((row) => ({ ...row, navItemId: navById.get(row.id) ?? null }));

    const byId = indexCollections(collections);
    const keep = computeKeepSet(
      collections,
      byId,
      principal,
      visibleCountByCollection,
      access
    );

    // Project each kept node onto the nearest kept ancestor. This prevents a
    // denied canonical parent's id/name/slug from leaking while keeping an
    // independently admitted descendant reachable in both tree and flat shapes.
    const visibleParentById = new Map<string, string | null>();
    const visibleChildrenOf = new Map<string | null, CollectionRow[]>();
    for (const collection of collections) {
      if (!keep.has(collection.id)) continue;
      let visibleParentId = collection.parentId;
      const seen = new Set<string>([collection.id]);
      while (
        visibleParentId != null &&
        !keep.has(visibleParentId) &&
        !seen.has(visibleParentId)
      ) {
        seen.add(visibleParentId);
        visibleParentId = byId.get(visibleParentId)?.parentId ?? null;
      }
      if (visibleParentId != null && seen.has(visibleParentId)) {
        visibleParentId = null;
      }
      visibleParentById.set(collection.id, visibleParentId);
      const siblings = visibleChildrenOf.get(visibleParentId) ?? [];
      siblings.push(collection);
      visibleChildrenOf.set(visibleParentId, siblings);
    }

    const build = (parentId: string | null): CollectionTreeNode[] =>
      (visibleChildrenOf.get(parentId) ?? [])
        .map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          parentId: visibleParentById.get(c.id) ?? null,
          scope: c.ownerUserId == null ? "district" : "private",
          ownerUserId: c.ownerUserId,
          defaultVisibilityLevel: c.defaultVisibilityLevel,
          navItemId: c.navItemId,
          position: c.position,
          selectableForCreate: access.selectableCollectionIds.has(c.id),
          visibleObjectCount: visibleCountByCollection.get(c.id) ?? 0,
          children: build(c.id),
        }));

    return build(null);
  },

  /**
   * External picker projection. Visibility comes exclusively from `tree(req)`;
   * this method only adds stable display paths and an authoring eligibility flag.
   */
  async discover(
    req: Requester,
    options: {
      shape: "tree" | "flat";
      includeCreateSelection: boolean;
    }
  ): Promise<CollectionDiscoveryNode[] | FlatCollectionDiscoveryNode[]> {
    const tree = discoveryTree(
      await this.tree(req),
      [],
      options.includeCreateSelection
    );
    return options.shape === "flat" ? flattenDiscoveryTree(tree) : tree;
  },
};
