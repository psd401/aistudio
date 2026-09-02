/** @jest-environment node */

/**
 * Unit tests for `planSiblingMove` — the pure rule behind the sidebar tree's
 * drag-reorder (`collectionManagementService.move`).
 *
 * The group is resolved from the rows as they are NOW (same parent, same
 * owner, not archived), the moved row is re-inserted at `toIndex` with the
 * same `arrayMove` semantics as the drag preview, and every row in the group
 * is renumbered densely. These pin: arrayMove placement, index clamping,
 * archived and other-owner rows staying out of the group, an archived row
 * being refused as the MOVED row, no-op moves producing no updates, and
 * other parents being untouched.
 */

import { collectionManagementInternals } from "@/lib/content/collection-management-service";
import type { CollectionAccessRow } from "@/lib/content/collection-access";

const { planSiblingMove } = collectionManagementInternals;

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

const A = row("A", { position: 0 });
const B = row("B", { position: 1 });
const C = row("C", { position: 2 });
const D_CHILD = row("D", { parentId: "A", position: 0 });

describe("planSiblingMove", () => {
  it("re-inserts the moved row at toIndex with arrayMove semantics and renumbers densely", () => {
    const plan = planSiblingMove([A, B, C, D_CHILD], A, 2);
    expect(plan.order.map((r) => r.id)).toEqual(["B", "C", "A"]);
    expect(plan.updates.map(({ row: r, position }) => [r.id, position])).toEqual([
      ["B", 0],
      ["C", 1],
      ["A", 2],
    ]);
  });

  it("moving up takes the target's slot", () => {
    const plan = planSiblingMove([A, B, C], C, 0);
    expect(plan.order.map((r) => r.id)).toEqual(["C", "A", "B"]);
  });

  it("clamps toIndex into the group", () => {
    expect(planSiblingMove([A, B, C], A, 99).order.map((r) => r.id)).toEqual(["B", "C", "A"]);
    expect(planSiblingMove([A, B, C], C, -5).order.map((r) => r.id)).toEqual(["C", "A", "B"]);
  });

  it("a move to the current index changes nothing", () => {
    expect(planSiblingMove([A, B, C], B, 1).updates).toEqual([]);
  });

  it("leaves archived siblings out of the group and untouched", () => {
    const archived = row("X", { position: 1, archivedAt: new Date() });
    const plan = planSiblingMove([A, archived, B, C], C, 0);
    expect(plan.order.map((r) => r.id)).toEqual(["C", "A", "B"]);
    expect(plan.updates.some(({ row: r }) => r.id === "X")).toBe(false);
  });

  it("treats another owner's collection under the same parent as a non-sibling", () => {
    const mine1 = row("M1", { ownerUserId: 7, position: 0 });
    const mine2 = row("M2", { ownerUserId: 7, position: 1 });
    const shared = row("S", { ownerUserId: 8, position: 0 });
    const plan = planSiblingMove([mine1, shared, mine2], mine2, 0);
    expect(plan.order.map((r) => r.id)).toEqual(["M2", "M1"]);
    expect(plan.updates.some(({ row: r }) => r.id === "S")).toBe(false);
  });

  it("only touches the moved row's own parent", () => {
    const plan = planSiblingMove([A, B, C, D_CHILD], B, 0);
    expect(plan.updates.some(({ row: r }) => r.id === "D")).toBe(false);
  });

  it("refuses to reorder an archived row, rather than splicing it into the live group", () => {
    const archived = row("X", { position: 1, archivedAt: new Date() });
    expect(() => planSiblingMove([A, archived, B, C], archived, 0)).toThrow(
      /archived collection cannot be reordered/i
    );
  });

  it("renumbers densely even when stored positions have gaps", () => {
    const p10 = row("P10", { position: 10 });
    const p20 = row("P20", { position: 20 });
    const p30 = row("P30", { position: 30 });
    const plan = planSiblingMove([p10, p20, p30], p30, 0);
    expect(plan.updates.map(({ row: r, position }) => [r.id, position])).toEqual([
      ["P30", 0],
      ["P10", 1],
      ["P20", 2],
    ]);
  });
});
