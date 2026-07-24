/**
 * Unit tests for collectionService.tree (Issue #1054, §21).
 *
 * The acceptance heart of Phase 4 nav/IA: the section tree a requester sees is
 * filtered by visibility so a user never sees a section they cannot enter.
 *
 * Visibility model under test (collections have NO grant table, only a default
 * level):
 *  - public collection                 -> visible to everyone.
 *  - internal collection               -> visible to any authenticated principal.
 *  - private/group collection          -> NOT visible on the level check alone for
 *                                         a non-admin; visible only if it holds an
 *                                         object the requester can view.
 *  - admin                             -> sees every collection.
 *  - a collection lights up when it (or a descendant) holds a visible object, and
 *    every ANCESTOR of a visible node is kept so the tree stays connected.
 *
 * `loadAllCollections` (executeQuery) and
 * `visibilityService.visibleCountsByCollection` are mocked so the tree is computed
 * purely in memory.
 */

let allCollections: Array<{
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  defaultVisibilityLevel: string;
  navItemId: number | null;
  position: number;
}> = [];

let visibleObjects: Array<{ collectionId: string | null }> = [];

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => allCollections),
}));

jest.mock("@/lib/db/schema", () => ({
  contentCollections: {
    id: "cc.id",
    name: "cc.name",
    slug: "cc.slug",
    parentId: "cc.parentId",
    defaultVisibilityLevel: "cc.defaultVisibilityLevel",
    navItemId: "cc.navItemId",
    position: "cc.position",
  },
}));

jest.mock("drizzle-orm", () => ({
  asc: (c: unknown) => c,
}));

jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    // The tree derives section visibility from per-collection counts (a GROUP BY
    // aggregate in production). Fold the `visibleObjects` fixture into the same
    // count-map shape the real `visibleCountsByCollection` returns.
    visibleCountsByCollection: jest.fn(async () => {
      const counts = new Map<string, number>();
      for (const obj of visibleObjects) {
        if (obj.collectionId) {
          counts.set(obj.collectionId, (counts.get(obj.collectionId) ?? 0) + 1);
        }
      }
      return counts;
    }),
  },
}));

import { collectionService } from "@/lib/content/collection-service";
import type { CollectionTreeNode } from "@/lib/content/collection-service";
import type { Requester } from "@/lib/content/types";

const admin: Requester = { kind: "user", userId: 1, roles: ["administrator"], isAdmin: true };
const staff: Requester = { kind: "user", userId: 2, roles: ["staff"], isAdmin: false };
const guest: Requester = { kind: "user", userId: null, roles: [], isAdmin: false };

/** Flatten the tree to a set of collection ids for easy assertions. */
function idsIn(tree: CollectionTreeNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: CollectionTreeNode[]) => {
    for (const n of nodes) {
      out.add(n.id);
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

beforeEach(() => {
  allCollections = [];
  visibleObjects = [];
  jest.clearAllMocks();
});

describe("collectionService.tree visibility filtering", () => {
  it("shows public to everyone (including guests) and hides private/group from a guest", async () => {
    allCollections = [
      { id: "pub", name: "Public", slug: "public", parentId: null, defaultVisibilityLevel: "public", navItemId: null, position: 0 },
      { id: "int", name: "Internal", slug: "internal", parentId: null, defaultVisibilityLevel: "internal", navItemId: null, position: 1 },
      { id: "grp", name: "Group", slug: "group", parentId: null, defaultVisibilityLevel: "group", navItemId: null, position: 2 },
      { id: "prv", name: "Private", slug: "private", parentId: null, defaultVisibilityLevel: "private", navItemId: null, position: 3 },
    ];
    visibleObjects = []; // guest sees no group/private objects

    const tree = await collectionService.tree(guest);
    const ids = idsIn(tree);
    expect(ids.has("pub")).toBe(true);
    // A guest is unauthenticated -> internal level NOT admitted.
    expect(ids.has("int")).toBe(false);
    expect(ids.has("grp")).toBe(false);
    expect(ids.has("prv")).toBe(false);
  });

  it("shows internal to an authenticated non-admin, but not private/group without a visible object", async () => {
    allCollections = [
      { id: "int", name: "Internal", slug: "internal", parentId: null, defaultVisibilityLevel: "internal", navItemId: null, position: 0 },
      { id: "grp", name: "Group", slug: "group", parentId: null, defaultVisibilityLevel: "group", navItemId: null, position: 1 },
    ];
    visibleObjects = [];

    const ids = idsIn(await collectionService.tree(staff));
    expect(ids.has("int")).toBe(true);
    expect(ids.has("grp")).toBe(false);
  });

  it("lights up a group collection when the requester can view an object in it", async () => {
    allCollections = [
      { id: "grp", name: "High School", slug: "hs", parentId: null, defaultVisibilityLevel: "group", navItemId: null, position: 0 },
    ];
    // staff can view one object placed in the group collection (its own grants).
    visibleObjects = [{ collectionId: "grp" }, { collectionId: null }];

    const tree = await collectionService.tree(staff);
    const ids = idsIn(tree);
    expect(ids.has("grp")).toBe(true);
    // The count reflects only objects attributed to that collection.
    expect(tree[0].visibleObjectCount).toBe(1);
  });

  it("keeps ancestors of a visible deep section even when the ancestor is not directly enterable", async () => {
    allCollections = [
      // root is private (not directly enterable by staff), child is group with a
      // visible object -> child kept, and root kept as its ancestor.
      { id: "root", name: "Root", slug: "root", parentId: null, defaultVisibilityLevel: "private", navItemId: null, position: 0 },
      { id: "child", name: "Child", slug: "child", parentId: "root", defaultVisibilityLevel: "group", navItemId: null, position: 0 },
    ];
    visibleObjects = [{ collectionId: "child" }];

    const tree = await collectionService.tree(staff);
    const ids = idsIn(tree);
    expect(ids.has("root")).toBe(true);
    expect(ids.has("child")).toBe(true);
    // child nests under root.
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("root");
    expect(tree[0].children.map((c) => c.id)).toEqual(["child"]);
  });

  it("prunes an empty private subtree the requester cannot enter", async () => {
    allCollections = [
      { id: "root", name: "Root", slug: "root", parentId: null, defaultVisibilityLevel: "private", navItemId: null, position: 0 },
      { id: "child", name: "Child", slug: "child", parentId: "root", defaultVisibilityLevel: "private", navItemId: null, position: 0 },
    ];
    visibleObjects = [];

    const tree = await collectionService.tree(staff);
    expect(tree).toHaveLength(0);
  });

  it("shows every collection to an admin regardless of level", async () => {
    allCollections = [
      { id: "grp", name: "Group", slug: "group", parentId: null, defaultVisibilityLevel: "group", navItemId: null, position: 0 },
      { id: "prv", name: "Private", slug: "private", parentId: null, defaultVisibilityLevel: "private", navItemId: null, position: 1 },
    ];
    visibleObjects = [];

    const ids = idsIn(await collectionService.tree(admin));
    expect(ids.has("grp")).toBe(true);
    expect(ids.has("prv")).toBe(true);
  });
});

describe("collectionService.discover external picker projection (#1286)", () => {
  beforeEach(() => {
    allCollections = [
      {
        id: "root",
        name: "Technology Guides",
        slug: "technology-guides",
        parentId: null,
        defaultVisibilityLevel: "internal",
        navItemId: null,
        position: 0,
      },
      {
        id: "child",
        name: "Classroom",
        slug: "classroom",
        parentId: "root",
        defaultVisibilityLevel: "internal",
        navItemId: null,
        position: 0,
      },
    ];
  });

  it("adds stable paths and create selection to the existing visible tree", async () => {
    const result = await collectionService.discover(staff, {
      shape: "tree",
      includeCreateSelection: true,
    });

    expect(result).toEqual([
      expect.objectContaining({
        id: "root",
        path: ["Technology Guides"],
        selectableForCreate: true,
        children: [
          expect.objectContaining({
            id: "child",
            path: ["Technology Guides", "Classroom"],
            selectableForCreate: true,
          }),
        ],
      }),
    ]);
  });

  it("flattens in the tree's stable pre-order and omits create selection for read-only callers", async () => {
    const result = await collectionService.discover(staff, {
      shape: "flat",
      includeCreateSelection: false,
    });

    expect(result.map((node) => node.id)).toEqual(["root", "child"]);
    expect(result[1]).toEqual(
      expect.objectContaining({
        path: ["Technology Guides", "Classroom"],
      })
    );
    expect(result[0]).not.toHaveProperty("children");
    expect(result[0]).not.toHaveProperty("selectableForCreate");
  });
});
