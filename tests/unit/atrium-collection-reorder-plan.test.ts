/** @jest-environment node */

/**
 * Unit tests for `planSiblingReorder` — the pure validation behind the sidebar
 * tree's drag-reorder (`collectionManagementService.reorder`).
 *
 * Positions are dense (0,1,2…), so a reorder must renumber a COMPLETE sibling
 * group or the unlisted siblings collide with the renumbered ones and the tree
 * silently falls back to name order for the ties. These pin the rules that
 * make a drop mean exactly what was dragged: distinct ids, all present, true
 * siblings (same parent AND owner), and the whole live group.
 */

import { collectionManagementInternals } from "@/lib/content/collection-management-service";
import type { CollectionAccessRow } from "@/lib/content/collection-access";

const { planSiblingReorder } = collectionManagementInternals;

function row(
  id: string,
  values: Partial<CollectionAccessRow> = {}
): CollectionAccessRow {
  return {
    id,
    name: id,
    slug: id,
    parentId: null,
    ownerUserId: null,
    defaultVisibilityLevel: "internal",
    inheritGrants: true,
    position: 0,
    archivedAt: null,
    description: null,
    landingObjectId: null,
    heroImageKey: null,
    heroImageAlt: null,
    requiresApproval: false,
    ...values,
  };
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("planSiblingReorder", () => {
  const district = [
    row(A, { position: 0 }),
    row(B, { position: 1 }),
    row(C, { position: 2 }),
    // A different parent — never part of the top-level group.
    row(D, { parentId: A, position: 0 }),
  ];

  it("returns the rows in the requested order for a complete sibling group", () => {
    const plan = planSiblingReorder(district, [C, A, B]);
    expect(plan.parentId).toBeNull();
    expect(plan.ownerUserId).toBeNull();
    expect(plan.rows.map((r) => r.id)).toEqual([C, A, B]);
  });

  it("rejects duplicate ids", () => {
    expect(() => planSiblingReorder(district, [A, A, B])).toThrow(/Duplicate/);
  });

  it("rejects an id that does not exist", () => {
    expect(() =>
      planSiblingReorder(district, [A, B, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"])
    ).toThrow(/Collection not found/);
  });

  it("rejects a list that mixes parents (not siblings)", () => {
    expect(() => planSiblingReorder(district, [A, B, C, D])).toThrow(/siblings/);
  });

  it("rejects a partial group — every live sibling must be listed", () => {
    expect(() => planSiblingReorder(district, [A, B])).toThrow(/every collection/);
  });

  it("ignores archived siblings when judging completeness", () => {
    const withArchived = [
      ...district,
      row("ffffffff-ffff-4fff-8fff-ffffffffffff", {
        position: 3,
        archivedAt: new Date(),
      }),
    ];
    expect(planSiblingReorder(withArchived, [B, C, A]).rows.map((r) => r.id)).toEqual([
      B,
      C,
      A,
    ]);
  });

  it("treats two owners' private collections under the same parent as different groups", () => {
    const privates = [
      row(A, { ownerUserId: 7, position: 0 }),
      row(B, { ownerUserId: 7, position: 1 }),
      row(C, { ownerUserId: 8, position: 0 }),
    ];
    expect(planSiblingReorder(privates, [B, A]).ownerUserId).toBe(7);
    expect(() => planSiblingReorder(privates, [A, C])).toThrow(/siblings/);
  });
});
