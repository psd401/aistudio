/**
 * Unit tests for navItemService (Issue #1054, §21 — auto-nav on publish).
 *
 * Covers the control flow the intranet adapter drives:
 *  - ensureNavItem with a collection  -> parent lookup, then an atomic UPSERT
 *                                        (INSERT ... ON CONFLICT (content_object_id)
 *                                        DO UPDATE) parented under the collection's
 *                                        nav_item_id, linking /c/<slug>, keyed by
 *                                        content_object_id, re-activating on conflict
 *                                        (republish). Migration 087's
 *                                        uq_nav_content_object makes this atomic, so
 *                                        there is no separate check-then-insert race.
 *  - ensureNavItem with no collection -> top-level (parentId null), no parent lookup.
 *  - hideNavItem                      -> soft-deactivate (is_active=false) keyed by
 *                                        content_object_id.
 *
 * DB access is mocked with a RECORDING proxy so each query (parentFor / upsert /
 * hide) is both dispatched by label AND has its written values asserted (a mock
 * that discarded `.values()`/`.set()` args could not catch e.g. "always writes
 * parentId: null" or "never re-activates on conflict").
 */

interface Op {
  m: string;
  args: unknown[];
}
interface QueryCall {
  label: string;
  ops: Op[];
}
let queryCalls: QueryCall[] = [];
let parentNavItemId: number | null = null;

// A chainable proxy that records every (method, args) call into `ops` so the test
// can inspect what was passed to .values()/.set()/.onConflictDoUpdate(), then keeps
// chaining.
function recordingBuilder(ops: Op[]): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        return (...args: unknown[]) => {
          ops.push({ m: String(prop), args });
          return recordingBuilder(ops);
        };
      },
    }
  );
}

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(
    async (fn: (db: unknown) => unknown, label: string) => {
      const ops: Op[] = [];
      const db = new Proxy(
        {},
        {
          get(_t, prop) {
            return (...args: unknown[]) => {
              ops.push({ m: String(prop), args });
              return recordingBuilder(ops);
            };
          },
        }
      );
      fn(db);
      queryCalls.push({ label, ops });
      if (label === "navItem.parentFor") {
        return parentNavItemId == null ? [] : [{ navItemId: parentNavItemId }];
      }
      // upsert / hide resolve to an empty array (no RETURNING used).
      return [];
    }
  ),
}));

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
const callFor = (label: string) => queryCalls.find((c) => c.label === label);
const argOf = (label: string, method: string): Record<string, unknown> | undefined => {
  const op = callFor(label)?.ops.find((o) => o.m === method);
  return op?.args[0] as Record<string, unknown> | undefined;
};

beforeEach(() => {
  queryCalls = [];
  parentNavItemId = null;
  jest.clearAllMocks();
});

describe("navItemService.ensureNavItem", () => {
  it("upserts a content nav item under the collection nav item (atomic, keyed by content_object_id)", async () => {
    parentNavItemId = 42;

    await navItemService.ensureNavItem({
      id: "obj-1",
      title: "Board Policy 4040",
      slug: "board-policy-4040",
      collectionId: "coll-1",
    });

    // parentFor (collection lookup) -> single atomic upsert (no separate
    // findExisting/insert/update — the ON CONFLICT handles the republish branch).
    expect(labels()).toEqual(["navItem.parentFor", "navItem.upsert"]);

    // The INSERT values: keyed by content_object_id, parented under the
    // collection's nav item, linking the reader route, active, type 'link'.
    const values = argOf("navItem.upsert", "values");
    expect(values).toMatchObject({
      label: "Board Policy 4040",
      link: "/c/board-policy-4040",
      parentId: 42,
      contentObjectId: "obj-1",
      type: "link",
      isActive: true,
    });

    // The ON CONFLICT (content_object_id) DO UPDATE re-activates + refreshes the
    // SAME row on republish — isActive MUST be reset true (an unpublish set it
    // false), and the target MUST be the content_object_id column.
    const conflict = argOf("navItem.upsert", "onConflictDoUpdate");
    expect(conflict?.target).toBe("ni.contentObjectId");
    expect(conflict?.set).toMatchObject({
      label: "Board Policy 4040",
      link: "/c/board-policy-4040",
      parentId: 42,
      type: "link",
      isActive: true,
    });
  });

  it("does NOT look up a parent when the object has no collection (top-level, parentId null)", async () => {
    await navItemService.ensureNavItem({
      id: "obj-2",
      title: "Loose doc",
      slug: "loose-doc",
      collectionId: null,
    });

    // No parentFor lookup; straight to the upsert.
    expect(labels()).toEqual(["navItem.upsert"]);
    expect(argOf("navItem.upsert", "values")).toMatchObject({
      contentObjectId: "obj-2",
      parentId: null,
      link: "/c/loose-doc",
      isActive: true,
    });
  });

  it("issues exactly one atomic upsert on republish (no check-then-insert race window)", async () => {
    parentNavItemId = 7;

    await navItemService.ensureNavItem({
      id: "obj-3",
      title: "Updated title",
      slug: "updated-title",
      collectionId: "coll-9",
    });

    // Single upsert — the idempotency that was a SELECT-then-UPDATE is now the
    // DB's ON CONFLICT, so there is no second statement to race.
    expect(labels()).toEqual(["navItem.parentFor", "navItem.upsert"]);
    expect(labels().filter((l) => l === "navItem.upsert")).toHaveLength(1);
    // Republish refreshes the label/parent via the conflict branch.
    expect(argOf("navItem.upsert", "onConflictDoUpdate")?.set).toMatchObject({
      label: "Updated title",
      parentId: 7,
      isActive: true,
    });
  });
});

describe("navItemService.hideNavItem", () => {
  it("soft-deactivates the nav item keyed by content_object_id", async () => {
    await navItemService.hideNavItem("obj-4");
    expect(labels()).toEqual(["navItem.hide"]);
    // The UPDATE sets is_active=false (soft hide; a later ensureNavItem re-activates).
    expect(argOf("navItem.hide", "set")).toMatchObject({ isActive: false });
  });
});
