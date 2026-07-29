/** @jest-environment node */

const executeQueryMock = jest.fn();

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));
jest.mock("@/lib/db/schema", () => ({
  contentCollections: {
    id: {},
    name: {},
    slug: {},
    parentId: {},
    ownerUserId: {},
    defaultVisibilityLevel: {},
    inheritGrants: {},
    position: {},
    archivedAt: {},
  },
  contentCollectionGrants: {
    collectionId: {},
    access: {},
    grantKind: {},
    grantValue: {},
  },
}));
jest.mock("drizzle-orm", () => ({
  asc: (value: unknown) => value,
}));

import { collectionAccessSnapshot } from "@/lib/content/collection-access";
import type { Requester } from "@/lib/content/types";

interface CollectionFixture {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  ownerUserId: number | null;
  defaultVisibilityLevel: "private" | "group" | "internal" | "public";
  inheritGrants: boolean;
  position: number;
  archivedAt: Date | null;
}

interface GrantFixture {
  collectionId: string;
  access: "view" | "create";
  kind: "role" | "group";
  value: string;
}

let collections: CollectionFixture[] = [];
let grants: GrantFixture[] = [];

const owner: Requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  groups: ["editors@psd401.net"],
  isAdmin: false,
};
const outsider: Requester = {
  kind: "user",
  userId: 8,
  roles: ["student"],
  groups: [],
  isAdmin: false,
};
const admin: Requester = {
  kind: "user",
  userId: 1,
  roles: ["administrator"],
  groups: [],
  isAdmin: true,
};

function row(
  id: string,
  values: Partial<CollectionFixture> = {}
): CollectionFixture {
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

beforeEach(() => {
  collections = [];
  grants = [];
  executeQueryMock.mockReset().mockImplementation(
    async (_callback: unknown, context: string) =>
      context === "collectionAccess.loadCollections" ? collections : grants
  );
});

describe("Atrium collection access", () => {
  it("keeps owner-bound private collections private even from administrators", async () => {
    collections = [
      row("private", {
        ownerUserId: 7,
        defaultVisibilityLevel: "private",
        inheritGrants: false,
      }),
    ];

    const ownerAccess = await collectionAccessSnapshot(owner);
    expect(ownerAccess.allowedCollectionIds.has("private")).toBe(true);
    expect(ownerAccess.selectableCollectionIds.has("private")).toBe(true);

    const adminAccess = await collectionAccessSnapshot(admin);
    expect(adminAccess.allowedCollectionIds.has("private")).toBe(false);
    expect(adminAccess.selectableCollectionIds.has("private")).toBe(false);
  });

  it("inherits distinct view/create grants through a district hierarchy", async () => {
    collections = [
      row("root"),
      row("child", { parentId: "root" }),
    ];
    grants = [
      {
        collectionId: "root",
        access: "view",
        kind: "role",
        value: "staff",
      },
      {
        collectionId: "root",
        access: "create",
        kind: "group",
        value: "editors@psd401.net",
      },
    ];

    const matching = await collectionAccessSnapshot(owner);
    expect(matching.allowedCollectionIds.has("child")).toBe(true);
    expect(matching.selectableCollectionIds.has("child")).toBe(true);

    const denied = await collectionAccessSnapshot(outsider);
    expect(denied.allowedCollectionIds.has("child")).toBe(false);
    expect(denied.selectableCollectionIds.has("child")).toBe(false);
  });

  it("cuts off inheritance and preserves zero-grant legacy behavior", async () => {
    collections = [
      row("root"),
      row("boundary", { parentId: "root", inheritGrants: false }),
    ];
    grants = [
      {
        collectionId: "root",
        access: "view",
        kind: "role",
        value: "staff",
      },
    ];

    const access = await collectionAccessSnapshot(outsider);
    expect(access.allowedCollectionIds.has("root")).toBe(false);
    expect(access.allowedCollectionIds.has("boundary")).toBe(true);
    expect(access.selectableCollectionIds.has("boundary")).toBe(true);
  });

  it("excludes archived collections from both view and create sets", async () => {
    collections = [row("archived", { archivedAt: new Date() })];
    const access = await collectionAccessSnapshot(owner);
    expect(access.allowedCollectionIds.has("archived")).toBe(false);
    expect(access.selectableCollectionIds.has("archived")).toBe(false);
  });
});
