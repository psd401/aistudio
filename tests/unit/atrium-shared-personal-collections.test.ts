/** @jest-environment node */

/**
 * Migration 178 — shared personal collections and the per-collection approver
 * roster.
 *
 * These two rules are the ones most likely to be broken by a later change, and
 * both fail SILENTLY if they are:
 *
 *  - Personal collections invert the district "zero grants = unrestricted"
 *    default. If that inversion is ever lost, every private tree in the
 *    district becomes readable by everyone, and nothing errors.
 *  - An `approve` grant must confer no view or create access. If access
 *    matching ever stops discriminating on the exact access level, naming
 *    someone an approver would quietly hand them the contents too.
 */

import {
  accessInternals,
  isCollectionApprover,
  type CollectionAccessRow,
} from "@/lib/content/collection-access";
import type { CollectionGrant, Requester } from "@/lib/content/types";

const owner: Requester = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };
const grantee: Requester = { kind: "user", userId: 8, roles: ["staff"], isAdmin: false };
const stranger: Requester = { kind: "user", userId: 9, roles: ["staff"], isAdmin: false };
const admin: Requester = { kind: "user", userId: 1, roles: ["administrator"], isAdmin: true };

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

/** A personal collection, as migration 178 permits it to be shared. */
function personal(id: string, values: Partial<CollectionAccessRow> = {}) {
  return row(id, {
    ownerUserId: 7,
    defaultVisibilityLevel: "private",
    inheritGrants: false,
    ...values,
  });
}

function snapshotFor(
  req: Requester,
  rows: CollectionAccessRow[],
  grants: Map<string, CollectionGrant[]> = new Map()
) {
  return accessInternals.accessSnapshotFromRows(req, rows, grants);
}

describe("personal collection access (migration 178)", () => {
  it("admits only the owner when the collection carries no grants", () => {
    const rows = [personal("mine")];

    expect(snapshotFor(owner, rows).allowedCollectionIds.has("mine")).toBe(true);
    expect(snapshotFor(grantee, rows).allowedCollectionIds.has("mine")).toBe(false);
    // The inversion that matters: for a DISTRICT collection zero view grants
    // means unrestricted. Reusing that rule here would expose every private
    // tree in the district.
    expect(snapshotFor(stranger, rows).allowedCollectionIds.has("mine")).toBe(false);
  });

  it("keeps a personal collection out of an administrator's tree", () => {
    // Object-level canView already gives admins the CONTENTS; the collection is
    // someone's own organization of their work and stays out of admin sidebars.
    const snapshot = snapshotFor(admin, [personal("mine")]);
    expect(snapshot.allowedCollectionIds.has("mine")).toBe(false);
    expect(snapshot.selectableCollectionIds.has("mine")).toBe(false);
  });

  it("admits an explicit grantee once the owner shares it", () => {
    const rows = [personal("mine", { defaultVisibilityLevel: "group" })];
    const grants = new Map<string, CollectionGrant[]>([
      ["mine", [{ access: "view", kind: "user", value: "8" }]],
    ]);

    expect(snapshotFor(grantee, rows, grants).allowedCollectionIds.has("mine")).toBe(true);
    // View access alone must not let a grantee file content into someone
    // else's collection.
    expect(snapshotFor(grantee, rows, grants).selectableCollectionIds.has("mine")).toBe(false);
    // A share with one person is not a share with everyone.
    expect(snapshotFor(stranger, rows, grants).allowedCollectionIds.has("mine")).toBe(false);
  });

  it("treats a create grant as implying view", () => {
    const rows = [personal("mine", { defaultVisibilityLevel: "group" })];
    const grants = new Map<string, CollectionGrant[]>([
      ["mine", [{ access: "create", kind: "user", value: "8" }]],
    ]);
    const snapshot = snapshotFor(grantee, rows, grants);

    expect(snapshot.allowedCollectionIds.has("mine")).toBe(true);
    expect(snapshot.selectableCollectionIds.has("mine")).toBe(true);
  });

  it("does not let an approve grant confer view or create", () => {
    const rows = [personal("mine", { defaultVisibilityLevel: "group" })];
    const grants = new Map<string, CollectionGrant[]>([
      ["mine", [{ access: "approve", kind: "user", value: "8" }]],
    ]);
    const snapshot = snapshotFor(grantee, rows, grants);

    expect(snapshot.allowedCollectionIds.has("mine")).toBe(false);
    expect(snapshot.selectableCollectionIds.has("mine")).toBe(false);
  });

  it("never inherits grants into a personal tree from a district ancestor", () => {
    // Cross-scope parents are rejected at write time, but the resolver must not
    // rely on that: a legacy or hand-edited row must still not inherit.
    const parent = row("district-parent");
    const child = personal("mine", {
      parentId: "district-parent",
      defaultVisibilityLevel: "group",
    });
    const grants = new Map<string, CollectionGrant[]>([
      ["district-parent", [{ access: "view", kind: "user", value: "8" }]],
    ]);

    const snapshot = snapshotFor(grantee, [parent, child], grants);
    expect(snapshot.allowedCollectionIds.has("mine")).toBe(false);
  });
});

describe("collection approver roster (migration 178)", () => {
  const noGrants = {
    effectiveGrants: () => [],
    directGrants: new Map<string, CollectionGrant[]>(),
  };

  it("always admits district administrators", () => {
    const gated = row("intranet", { requiresApproval: true });
    expect(isCollectionApprover(admin, gated, noGrants)).toBe(true);
  });

  it("admits a personal collection's owner", () => {
    const gated = personal("mine", { requiresApproval: true });
    expect(isCollectionApprover(owner, gated, noGrants)).toBe(true);
    expect(isCollectionApprover(grantee, gated, noGrants)).toBe(false);
  });

  it("admits a named approver on a district collection, by role", () => {
    const gated = row("sops", { requiresApproval: true });
    const approveGrants: CollectionGrant[] = [
      { access: "approve", kind: "role", value: "staff" },
    ];
    const access = {
      effectiveGrants: (_id: string, level: string) =>
        level === "approve" ? approveGrants : [],
      directGrants: new Map<string, CollectionGrant[]>(),
    };

    expect(isCollectionApprover(grantee, gated, access)).toBe(true);
  });

  it("reads a personal collection's approvers from its OWN grants only", () => {
    const gated = personal("mine", {
      requiresApproval: true,
      defaultVisibilityLevel: "group",
    });
    const access = {
      // An inherited approve grant must be ignored for a personal collection —
      // if this were consulted, the test would wrongly pass.
      effectiveGrants: (): CollectionGrant[] => [
        { access: "approve", kind: "user", value: "9" },
      ],
      directGrants: new Map<string, CollectionGrant[]>([
        ["mine", [{ access: "approve", kind: "user", value: "8" }]],
      ]),
    };

    expect(isCollectionApprover(grantee, gated, access)).toBe(true);
    expect(isCollectionApprover(stranger, gated, access)).toBe(false);
  });
});
