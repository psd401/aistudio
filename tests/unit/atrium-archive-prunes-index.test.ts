/**
 * Wiring tests: `contentService.update` prunes the retrieval index on an
 * archive write (Epic #1059 completion) — archived content must stop surfacing
 * as assistant context (§16).
 *
 *  - `status: "archived"` → `retrievalService.removeFromIndex(objectId)` runs
 *    AFTER the metadata update commits (best-effort: a prune failure is logged,
 *    never thrown — the update still succeeds).
 *  - Non-archive updates (title, draft status) never touch the index.
 *
 * The service lazy-imports `./retrieval-service` (a static import back would be
 * a module cycle — retrieval-service statically imports content-service), so
 * the retrieval-service mock here also proves the lazy path resolves.
 */

const updateRows: Array<Array<Record<string, unknown>>> = [];

jest.mock("@/lib/db/drizzle-client", () => ({
  // Serves loadByIdOrSlug and the UPDATE ... RETURNING in call order.
  executeQuery: jest.fn(async () => updateRows.shift() ?? []),
  executeTransaction: jest.fn(async () => {
    throw new Error("update should not open a transaction");
  }),
}));
jest.mock("@/lib/db/schema", () => ({
  contentObjects: { id: "id", slug: "slug" },
  contentCollections: {},
  contentVersions: {},
}));
jest.mock("@/lib/db/json-utils", () => ({
  safeJsonbStringify: (v: unknown) => JSON.stringify(v),
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => a,
  like: (...a: unknown[]) => a,
  sql: Object.assign((..._a: unknown[]) => ({}), { join: () => ({}) }),
}));
jest.mock("@/lib/content/mappers", () => ({
  objectSelectFields: {},
  rowToObjectDTO: (row: Record<string, unknown>) => row,
}));
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: jest.fn(async () => true),
    assertWritableLevel: jest.fn(),
    applyGrantsForLevel: jest.fn(),
  },
}));
jest.mock("@/lib/content/events", () => ({
  contentEvents: { emit: jest.fn(async () => undefined) },
}));
jest.mock("@/lib/content/version-service", () => ({
  snapshotInTx: jest.fn(),
  versionService: { snapshot: jest.fn(), flushSnapshotWrites: jest.fn() },
}));

const removeFromIndexMock = jest.fn(async (_objectId: string) => undefined);
jest.mock("@/lib/content/retrieval-service", () => ({
  retrievalService: {
    // Lazy deref: jest.mock factories hoist above the const declaration.
    removeFromIndex: (objectId: string) => removeFromIndexMock(objectId),
  },
}));

import { contentService } from "@/lib/content/content-service";
import type { Requester } from "@/lib/content/types";

const owner: Requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};

const baseObj = {
  id: "11111111-1111-1111-1111-111111111111",
  kind: "document",
  ownerUserId: 7,
  visibilityLevel: "internal",
  status: "published",
  tags: [],
};

beforeEach(() => {
  updateRows.length = 0;
  removeFromIndexMock.mockClear();
  removeFromIndexMock.mockResolvedValue(undefined);
});

describe("contentService.update archive → retrieval-index prune", () => {
  it("prunes the index when status transitions to archived", async () => {
    updateRows.push(
      [{ ...baseObj }], // loadByIdOrSlug
      [{ ...baseObj, status: "archived" }] // UPDATE ... RETURNING
    );
    const result = await contentService.update(owner, baseObj.id, {
      status: "archived",
    });
    expect(result.status).toBe("archived");
    expect(removeFromIndexMock).toHaveBeenCalledTimes(1);
    expect(removeFromIndexMock).toHaveBeenCalledWith(baseObj.id);
  });

  it("still succeeds when the prune fails (best-effort, logged not thrown)", async () => {
    removeFromIndexMock.mockRejectedValueOnce(new Error("prune boom"));
    updateRows.push([{ ...baseObj }], [{ ...baseObj, status: "archived" }]);
    const result = await contentService.update(owner, baseObj.id, {
      status: "archived",
    });
    expect(result.status).toBe("archived");
  });

  it("does NOT prune on a non-archive status update", async () => {
    updateRows.push([{ ...baseObj }], [{ ...baseObj, status: "draft" }]);
    await contentService.update(owner, baseObj.id, { status: "draft" });
    expect(removeFromIndexMock).not.toHaveBeenCalled();
  });

  it("does NOT prune on a metadata-only update", async () => {
    updateRows.push([{ ...baseObj }], [{ ...baseObj, title: "New" }]);
    await contentService.update(owner, baseObj.id, { title: "New" });
    expect(removeFromIndexMock).not.toHaveBeenCalled();
  });
});
