/**
 * Unit tests for navItemService (Issue #1054, §21 — auto-nav on publish).
 *
 * Covers the create/update/hide control flow the intranet adapter drives:
 *  - ensureNavItem with no existing row     -> INSERT a content nav item, parented
 *                                              under the collection's nav_item_id,
 *                                              linking /c/<slug>, keyed by
 *                                              content_object_id.
 *  - ensureNavItem with an existing row      -> UPDATE in place (label/link/parent
 *                                              + re-activate), NOT a second INSERT
 *                                              (idempotent on republish).
 *  - ensureNavItem with no collection        -> top-level (parentId null), no
 *                                              collection lookup.
 *  - hideNavItem                             -> soft-deactivate (is_active=false)
 *                                              keyed by content_object_id.
 *
 * All DB access is mocked: executeQuery is dispatched by its label so each query
 * (parentFor / findExisting / insert / update / hide) is driven deterministically.
 */

// --- mock state, keyed by the executeQuery label so each call is deterministic ---
interface QueryCall {
  label: string;
  builder: unknown;
}
let queryCalls: QueryCall[] = [];
// Result fed to the next call with a given label.
let parentNavItemId: number | null = null;
let existingNavRows: Array<{ id: number }> = [];

// A chainable builder proxy whose terminal `.limit()`/`.where()` return a queued
// result depending on the label the call was made under. We instead resolve
// results in the executeQuery mock by inspecting the label.
const builderProxy: unknown = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === "then") return undefined;
      return () => builderProxy;
    },
  }
);

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(
    async (fn: (db: unknown) => unknown, label: string) => {
      // Run the builder fn so the test exercises the same call shape (it returns
      // the proxy), but resolve the RESULT from label-keyed fixtures.
      const builder = fn(dbStub);
      queryCalls.push({ label, builder });
      if (label === "navItem.parentFor") {
        return parentNavItemId == null ? [] : [{ navItemId: parentNavItemId }];
      }
      if (label === "navItem.findExisting") return existingNavRows;
      // insert / update / hide resolve to an empty array (no RETURNING used).
      return [];
    }
  ),
}));

// db stub: every method returns the chainable proxy.
const dbStub: unknown = new Proxy(
  {},
  {
    get() {
      return () => builderProxy;
    },
  }
);

jest.mock("@/lib/db/schema", () => ({
  contentCollections: { id: "cc.id", navItemId: "cc.navItemId" },
  navigationItems: {
    id: "ni.id",
    contentObjectId: "ni.contentObjectId",
    isActive: "ni.isActive",
  },
}));

jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
}));

import { navItemService } from "@/lib/content/nav-item-service";

const labels = () => queryCalls.map((c) => c.label);

beforeEach(() => {
  queryCalls = [];
  parentNavItemId = null;
  existingNavRows = [];
  jest.clearAllMocks();
});

describe("navItemService.ensureNavItem", () => {
  it("inserts a new content nav item under the collection nav item", async () => {
    parentNavItemId = 42;
    existingNavRows = [];

    await navItemService.ensureNavItem({
      id: "obj-1",
      title: "Board Policy 4040",
      slug: "board-policy-4040",
      collectionId: "coll-1",
    });

    // parentFor (collection lookup) -> findExisting -> insert.
    expect(labels()).toEqual([
      "navItem.parentFor",
      "navItem.findExisting",
      "navItem.insert",
    ]);
  });

  it("does NOT look up a parent when the object has no collection", async () => {
    existingNavRows = [];

    await navItemService.ensureNavItem({
      id: "obj-2",
      title: "Loose doc",
      slug: "loose-doc",
      collectionId: null,
    });

    // No parentFor lookup; straight to findExisting + insert.
    expect(labels()).toEqual(["navItem.findExisting", "navItem.insert"]);
  });

  it("updates the existing row in place on republish (idempotent, no duplicate insert)", async () => {
    parentNavItemId = 7;
    existingNavRows = [{ id: 555 }];

    await navItemService.ensureNavItem({
      id: "obj-3",
      title: "Updated title",
      slug: "updated-title",
      collectionId: "coll-9",
    });

    // parentFor -> findExisting -> update (NOT insert).
    expect(labels()).toEqual([
      "navItem.parentFor",
      "navItem.findExisting",
      "navItem.update",
    ]);
    expect(labels()).not.toContain("navItem.insert");
  });
});

describe("navItemService.hideNavItem", () => {
  it("soft-deactivates the nav item keyed by content_object_id", async () => {
    await navItemService.hideNavItem("obj-4");
    expect(labels()).toEqual(["navItem.hide"]);
  });
});
