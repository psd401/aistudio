/**
 * DB-LAYER system-managed-repository guard (issue #1118 item 4).
 *
 * The action-layer `assertNotSystemManagedRepository` is opt-in at 11 call sites,
 * so a future DIRECT caller of the public-barrel write functions
 * (createRepositoryItem / updateRepositoryItemStatus / deleteRepositoryItem) would
 * silently bypass system-repo protection. These tests exercise the REAL functions
 * in `lib/db/drizzle/knowledge-repositories.ts` and prove the guard now lives in
 * the DB layer: a system-managed repository (the Atrium retrieval index) is
 * refused and NO write is issued, while a normal repository still writes.
 *
 * Every DB call routes through the mocked `executeQuery`, dispatched by its label
 * (2nd arg), so the real functions run without a database.
 */

const queryByLabel = new Map<string, unknown>();
const executeQueryMock = jest.fn(async (_cb: unknown, label?: string) => {
  if (!label || !queryByLabel.has(label)) {
    throw new Error(`unexpected query label: ${label}`);
  }
  return queryByLabel.get(label);
});
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...a: unknown[]) =>
    executeQueryMock(...(a as Parameters<typeof executeQueryMock>)),
}));
jest.mock("@/lib/db/schema", () => ({
  knowledgeRepositories: { id: "id", metadata: "metadata" },
  repositoryItems: { id: "id", repositoryId: "repository_id" },
  repositoryItemChunks: {},
  repositoryAccess: {},
  users: {},
  userRoles: {},
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => a,
  or: (...a: unknown[]) => a,
  inArray: (...a: unknown[]) => a,
  isNotNull: (a: unknown) => a,
  sql: Object.assign((..._a: unknown[]) => ({}), {}),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  sanitizeForLogging: (v: unknown) => v,
}));

import {
  createRepositoryItem,
  updateRepositoryItemStatus,
  deleteRepositoryItem,
} from "@/lib/db/drizzle/knowledge-repositories";

const SYSTEM_META = { systemManaged: true };

beforeEach(() => {
  queryByLabel.clear();
  executeQueryMock.mockClear();
});

function labelWasQueried(label: string): boolean {
  return executeQueryMock.mock.calls.some((c) => c[1] === label);
}

describe("createRepositoryItem — DB-layer system-repo guard", () => {
  it("REFUSES a system-managed repository and issues NO insert", async () => {
    queryByLabel.set("getRepositoryById", [{ id: 9, metadata: SYSTEM_META }]);
    queryByLabel.set("createRepositoryItem", [{ id: 10 }]);
    await expect(
      createRepositoryItem({
        repositoryId: 9,
        type: "document",
        name: "x",
        source: "s",
      })
    ).rejects.toThrow(/system-managed/);
    expect(labelWasQueried("createRepositoryItem")).toBe(false);
  });

  it("ALLOWS a normal repository and inserts", async () => {
    queryByLabel.set("getRepositoryById", [{ id: 3, metadata: null }]);
    queryByLabel.set("createRepositoryItem", [{ id: 10, repositoryId: 3 }]);
    const row = await createRepositoryItem({
      repositoryId: 3,
      type: "document",
      name: "x",
      source: "s",
    });
    expect(row).toMatchObject({ id: 10 });
    expect(labelWasQueried("createRepositoryItem")).toBe(true);
  });
});

describe("updateRepositoryItemStatus — DB-layer system-repo guard", () => {
  it("REFUSES an item in a system-managed repo and issues NO update", async () => {
    queryByLabel.set("assertRepositoryItemNotSystemManaged", [
      { metadata: SYSTEM_META },
    ]);
    queryByLabel.set("updateRepositoryItemStatus", [{ id: 5 }]);
    await expect(updateRepositoryItemStatus(5, "completed")).rejects.toThrow(
      /system-managed/
    );
    expect(labelWasQueried("updateRepositoryItemStatus")).toBe(false);
  });

  it("ALLOWS an item in a normal repo and updates", async () => {
    queryByLabel.set("assertRepositoryItemNotSystemManaged", [{ metadata: null }]);
    queryByLabel.set("updateRepositoryItemStatus", [{ id: 6 }]);
    const row = await updateRepositoryItemStatus(6, "completed");
    expect(row).toMatchObject({ id: 6 });
    expect(labelWasQueried("updateRepositoryItemStatus")).toBe(true);
  });

  it("does NOT block a MISSING item (guard preserves not-found no-op behaviour)", async () => {
    queryByLabel.set("assertRepositoryItemNotSystemManaged", []); // item not found
    queryByLabel.set("updateRepositoryItemStatus", []); // update affects nothing
    const row = await updateRepositoryItemStatus(999, "completed");
    expect(row).toBeNull();
    expect(labelWasQueried("updateRepositoryItemStatus")).toBe(true);
  });
});

describe("deleteRepositoryItem — DB-layer system-repo guard", () => {
  it("REFUSES an item in a system-managed repo and issues NO delete", async () => {
    queryByLabel.set("assertRepositoryItemNotSystemManaged", [
      { metadata: SYSTEM_META },
    ]);
    queryByLabel.set("deleteRepositoryItem", [{ id: 5 }]);
    await expect(deleteRepositoryItem(5)).rejects.toThrow(/system-managed/);
    expect(labelWasQueried("deleteRepositoryItem")).toBe(false);
  });

  it("ALLOWS deleting an item in a normal repo", async () => {
    queryByLabel.set("assertRepositoryItemNotSystemManaged", [{ metadata: null }]);
    queryByLabel.set("deleteRepositoryItem", [{ id: 6 }]);
    const count = await deleteRepositoryItem(6);
    expect(count).toBe(1);
    expect(labelWasQueried("deleteRepositoryItem")).toBe(true);
  });
});
