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
    description: null,
    landingObjectId: null,
    heroImageKey: null,
    heroImageAlt: null,
    requiresApproval: false,
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
    expect(collectionManagementInternals.nextPosition(rows, null, null)).toBe(1);
  });

  it("allocates top-level positions only within the same owner hierarchy", () => {
    const rows = [
      row("district", { position: 4 }),
      row("owner-seven-max", {
        ownerUserId: 7,
        position: 2_147_483_647,
      }),
      row("owner-eight", { ownerUserId: 8, position: 2 }),
    ];

    expect(collectionManagementInternals.nextPosition(rows, null, null)).toBe(5);
    expect(collectionManagementInternals.nextPosition(rows, null, 7)).toBe(0);
    expect(collectionManagementInternals.nextPosition(rows, null, 8)).toBe(3);
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

describe("replaceGrants — grant TARGET existence (collection level)", () => {
  // Atrium keeps grants in TWO tables and checks BOTH boundaries: the collection
  // must admit the requester AND the object must grant them. Prod 2026-09-15
  // proved the collection table had the same defect as the object table — a
  // Google personId and an unsynced group email both passed `normalizeGrants`
  // (shape only), stored cleanly, and authorized nobody. `replaceGrants` is the
  // single write path for create AND update, so the check belongs here.

  /**
   * Minimal tx recording the delete/insert, with a `select` standing in for the
   * two target lookups in `assertGrantTargetsExist`.
   *
   * Keyed on the PROJECTION (`{ id }` for users, `{ email }` for groups) rather
   * than on call order: the helper skips the query for a kind that is absent, so
   * a group-only payload makes the groups lookup the FIRST call.
   */
  function fakeTx(known: { userIds?: number[]; groupEmails?: string[] } = {}) {
    const userIds = known.userIds ?? [7, 215];
    const groupEmails = known.groupEmails ?? ["cabinet@psd401.net"];
    const calls: string[] = [];
    const inserted: unknown[] = [];
    const tx = {
      delete: () => ({
        where: async () => {
          calls.push("delete");
        },
      }),
      insert: () => ({
        values: async (rows: unknown) => {
          calls.push("insert");
          inserted.push(rows);
        },
      }),
      select: (columns: Record<string, unknown>) => ({
        from: () => ({
          where: async () =>
            "email" in columns
              ? groupEmails.map((email) => ({ email }))
              : userIds.map((id) => ({ id })),
        }),
      }),
    };
    return { tx: tx as never, calls, inserted };
  }

  const replace = (tx: never, grants: unknown[]) =>
    collectionManagementInternals.replaceGrants(
      tx,
      "2a07b463-920a-4341-b9e9-2e085bd65def",
      grants as never
    );

  it("rejects a Google personId supplied as a collection user grant", async () => {
    // The exact value written to content_collection_grants in prod.
    const { tx, calls } = fakeTx({ userIds: [215] });
    await expect(
      replace(tx, [
        { access: "view", kind: "user", value: "113772684364830001020" },
      ])
    ).rejects.toThrow(/Unknown user id.*personId/is);
    // Ordered BEFORE the delete, so a bad grant never clears the live roster.
    expect(calls).toEqual([]);
  });

  it("rejects a group the sync has never ingested", async () => {
    const { tx, calls } = fakeTx({ groupEmails: ["psd-staff@psd401.net"] });
    await expect(
      replace(tx, [{ access: "view", kind: "group", value: "cabinet@psd401.net" }])
    ).rejects.toThrow(/not synced.*cabinet@psd401\.net/is);
    expect(calls).toEqual([]);
  });

  it("writes grants whose targets all exist", async () => {
    const { tx, calls, inserted } = fakeTx({
      userIds: [215],
      groupEmails: ["cabinet@psd401.net"],
    });
    await replace(tx, [
      { access: "view", kind: "user", value: "215" },
      { access: "view", kind: "group", value: "cabinet@psd401.net" },
    ]);
    expect(calls).toEqual(["delete", "insert"]);
    expect(inserted[0]).toEqual([
      {
        collectionId: "2a07b463-920a-4341-b9e9-2e085bd65def",
        access: "view",
        grantKind: "user",
        grantValue: "215",
      },
      {
        collectionId: "2a07b463-920a-4341-b9e9-2e085bd65def",
        access: "view",
        grantKind: "group",
        grantValue: "cabinet@psd401.net",
      },
    ]);
  });

  it("still clears grants when handed an empty set (no lookup, delete only)", async () => {
    // Un-sharing a personal collection calls replaceGrants(tx, id, []) — the
    // existence check must not turn that into a no-op or an error.
    const { tx, calls } = fakeTx();
    await replace(tx, []);
    expect(calls).toEqual(["delete"]);
  });

  it("does not existence-check role or building collection grants", async () => {
    const { tx, calls } = fakeTx({ userIds: [], groupEmails: [] });
    await replace(tx, [
      { access: "create", kind: "role", value: "administrator" },
      { access: "view", kind: "building", value: "Peninsula High School" },
    ]);
    expect(calls).toEqual(["delete", "insert"]);
  });
});
