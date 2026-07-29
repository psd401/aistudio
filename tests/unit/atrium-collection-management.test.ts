/** @jest-environment node */

import { collectionManagementInternals } from "@/lib/content/collection-management-service";
import type { Requester } from "@/lib/content/types";
import type { CollectionAccessRow } from "@/lib/content/collection-access";

const owner: Requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};
const other: Requester = {
  kind: "user",
  userId: 8,
  roles: ["staff"],
  isAdmin: false,
};
const admin: Requester = {
  kind: "user",
  userId: 1,
  roles: ["administrator"],
  isAdmin: true,
};

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
    ...values,
  };
}

describe("collection management hierarchy rules", () => {
  it("rejects malformed collection ids before a UUID query can reach PostgreSQL", () => {
    expect(() =>
      collectionManagementInternals.assertCollectionId("not-a-uuid")
    ).toThrow(/valid UUID/);
    expect(() =>
      collectionManagementInternals.assertCollectionId(
        "f9999999-9999-4999-8999-999999999999"
      )
    ).not.toThrow();
  });

  it("separates district administration from private ownership", () => {
    const district = row("district");
    const privateRow = row("private", {
      ownerUserId: 7,
      defaultVisibilityLevel: "private",
      inheritGrants: false,
    });

    expect(() =>
      collectionManagementInternals.assertMayManage(admin, district)
    ).not.toThrow();
    expect(() =>
      collectionManagementInternals.assertMayManage(owner, district)
    ).toThrow(/Administrator authority/);
    expect(() =>
      collectionManagementInternals.assertMayManage(owner, privateRow)
    ).not.toThrow();
    expect(() =>
      collectionManagementInternals.assertMayManage(admin, privateRow)
    ).toThrow(/only private collections you own/);
    expect(() =>
      collectionManagementInternals.assertMayManage(other, privateRow)
    ).toThrow(/Collection not found/);
    expect(() =>
      collectionManagementInternals.assertMayCreateScope(owner, "district")
    ).toThrow(/Administrator authority/);
    expect(
      collectionManagementInternals.assertMayCreateScope(owner, "private")
    ).toBe(7);
    expect(
      collectionManagementInternals.assertMayCreateScope(admin, "district")
    ).toBeNull();
  });

  it("rejects cross-scope/cross-owner parents and hierarchy cycles", () => {
    const district = row("district");
    const privateRow = row("private", {
      ownerUserId: 7,
      defaultVisibilityLevel: "private",
      inheritGrants: false,
    });
    const otherPrivate = row("other-private", {
      ownerUserId: 8,
      defaultVisibilityLevel: "private",
      inheritGrants: false,
    });
    const child = row("child", { parentId: "district" });
    const rows = new Map(
      [district, privateRow, otherPrivate, child].map((item) => [item.id, item])
    );

    expect(() =>
      collectionManagementInternals.assertParent(
        rows,
        "district",
        "private",
        7
      )
    ).toThrow(/cannot be mixed/);
    expect(() =>
      collectionManagementInternals.assertParent(
        rows,
        "other-private",
        "private",
        7
      )
    ).toThrow(/Parent collection not found/);
    expect(() =>
      collectionManagementInternals.assertNoCycle(rows, "district", "child")
    ).toThrow(/cycle/);
  });

  it("detects name conflicts on move and walks archive subtrees once", () => {
    const rows = [
      row("root"),
      row("first", { name: "Policies", parentId: "root" }),
      row("second", { name: "Other", parentId: "root" }),
      row("grandchild", { parentId: "first" }),
    ];
    expect(() =>
      collectionManagementInternals.assertSiblingNameAvailable(
        rows,
        "POLICIES",
        "root",
        null,
        "second"
      )
    ).toThrow(/already exists/);
    expect(
      collectionManagementInternals.descendantIds(rows, "root")
    ).toEqual(expect.arrayContaining(["root", "first", "second", "grandchild"]));
    expect(
      new Set(collectionManagementInternals.descendantIds(rows, "root")).size
    ).toBe(4);
  });
});

describe("collection management naming and grants", () => {
  it("scopes top-level name conflicts to district or the private owner", () => {
    const rows = [
      row("district", { name: "Projects" }),
      row("owner-seven", { name: "Projects", ownerUserId: 7 }),
      row("owner-eight", { name: "Other", ownerUserId: 8 }),
    ];
    expect(() =>
      collectionManagementInternals.assertSiblingNameAvailable(
        rows,
        "Projects",
        null,
        8
      )
    ).not.toThrow();
    expect(() =>
      collectionManagementInternals.assertSiblingNameAvailable(
        rows,
        "Projects",
        null,
        7
      )
    ).toThrow(/already exists/);
  });

  it("namespaces private slugs so another owner's collision stays unobservable", () => {
    const rows = [
      row("owner-seven", {
        name: "Projects",
        slug: "private-7-projects",
        ownerUserId: 7,
      }),
    ];
    expect(
      collectionManagementInternals.nextSlug(rows, "Projects", 8)
    ).toBe("private-8-projects");
    expect(
      collectionManagementInternals.nextSlug(rows, "Projects", 7)
    ).toBe("private-7-projects-1");
  });

  it("keeps owner-prefixed private slugs within the database column limit", () => {
    const name = "a".repeat(200);
    const first = collectionManagementInternals.nextSlug([], name, 7);
    expect(first).toHaveLength(200);
    expect(first.startsWith("private-7-")).toBe(true);

    const collision = collectionManagementInternals.nextSlug(
      [row("existing", { slug: first, ownerUserId: 7 })],
      name,
      7
    );
    expect(collision).toHaveLength(200);
    expect(collision.endsWith("-1")).toBe(true);
  });

  it("allocates a safe position when a sibling already uses int4 max", () => {
    const rows = [
      row("max", { position: 2_147_483_647 }),
      row("zero", { position: 0 }),
    ];
    expect(collectionManagementInternals.nextPosition(rows, null)).toBe(1);
  });

  it("normalizes/deduplicates grants and rejects malformed group values", () => {
    expect(
      collectionManagementInternals.normalizeGrants([
        {
          access: "view",
          kind: "group",
          value: " STAFF@PSD401.NET ",
        },
        {
          access: "view",
          kind: "group",
          value: "staff@psd401.net",
        },
      ])
    ).toEqual([
      {
        access: "view",
        kind: "group",
        value: "staff@psd401.net",
      },
    ]);
    expect(() =>
      collectionManagementInternals.normalizeGrants([
        { access: "create", kind: "group", value: "not-an-email" },
      ])
    ).toThrow(/group email/);
  });
});

describe("collection management group defaults", () => {
  it("requires a direct or inherited effective view grant", () => {
    const parent = row("parent");
    const byId = new Map([[parent.id, parent]]);
    const parentViewGrant = new Map([
      [
        parent.id,
        [
          {
            access: "view" as const,
            kind: "role" as const,
            value: "staff",
          },
        ],
      ],
    ]);

    expect(() =>
      collectionManagementInternals.assertGroupDefaultHasEffectiveViewGrant(
        {
          level: "group",
          parentId: null,
          inheritGrants: true,
          ownGrants: [],
          byId,
          directGrants: new Map(),
        }
      )
    ).toThrow(/effective view grant/);
    expect(() =>
      collectionManagementInternals.assertGroupDefaultHasEffectiveViewGrant(
        {
          level: "group",
          parentId: parent.id,
          inheritGrants: true,
          ownGrants: [],
          byId,
          directGrants: parentViewGrant,
        }
      )
    ).not.toThrow();
    expect(() =>
      collectionManagementInternals.assertGroupDefaultHasEffectiveViewGrant(
        {
          level: "group",
          parentId: parent.id,
          inheritGrants: false,
          ownGrants: [],
          byId,
          directGrants: parentViewGrant,
        }
      )
    ).toThrow(/effective view grant/);
    expect(() =>
      collectionManagementInternals.assertGroupDefaultHasEffectiveViewGrant(
        {
          level: "group",
          parentId: null,
          inheritGrants: false,
          ownGrants: [
            { access: "create", kind: "role", value: "staff" },
          ],
          byId,
          directGrants: new Map(),
        }
      )
    ).toThrow(/effective view grant/);
    expect(() =>
      collectionManagementInternals.assertGroupDefaultHasEffectiveViewGrant(
        {
          level: "group",
          parentId: null,
          inheritGrants: false,
          ownGrants: [{ access: "view", kind: "role", value: "staff" }],
          byId,
          directGrants: new Map(),
        }
      )
    ).not.toThrow();
  });

  it("protects inherited group defaults throughout an updated subtree", () => {
    const root = row("root");
    const branch = row("branch", { parentId: root.id });
    const groupChild = row("group-child", {
      parentId: branch.id,
      defaultVisibilityLevel: "group",
    });
    const rows = [root, branch, groupChild];
    const rootViewGrant = new Map([
      [
        root.id,
        [
          {
            access: "view" as const,
            kind: "role" as const,
            value: "staff",
          },
        ],
      ],
    ]);

    expect(() =>
      collectionManagementInternals.assertUpdatedSubtreeGroupDefaults({
        rows,
        collectionId: root.id,
        parentId: null,
        inheritGrants: true,
        level: "internal",
        ownGrants: [],
        directGrants: rootViewGrant,
      })
    ).toThrow(/effective view grant/);
    expect(() =>
      collectionManagementInternals.assertUpdatedSubtreeGroupDefaults({
        rows,
        collectionId: branch.id,
        parentId: root.id,
        inheritGrants: false,
        level: "internal",
        ownGrants: [],
        directGrants: rootViewGrant,
      })
    ).toThrow(/effective view grant/);
    expect(() =>
      collectionManagementInternals.assertUpdatedSubtreeGroupDefaults({
        rows,
        collectionId: branch.id,
        parentId: root.id,
        inheritGrants: true,
        level: "internal",
        ownGrants: [],
        directGrants: rootViewGrant,
      })
    ).not.toThrow();
  });
});
