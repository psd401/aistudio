/**
 * Unit tests for contentService.createVersion orchestration (Issue #1058, §14).
 *
 * Covers the two review-flagged orchestration behaviors that sit ABOVE the
 * snapshot transaction:
 *  - Concurrent-conflict retry: a first `ConflictError` from the race-prone
 *    version-number allocation triggers exactly one transparent retry; a second
 *    conflict re-throws (PR #1061 review item 4).
 *  - Concurrent-delete safety: if the object is deleted between the snapshot
 *    commit and the post-snapshot reload, createVersion throws NotFoundError
 *    rather than returning a stale `updatedAt` (PR #1061 review item 3).
 *
 * Heavy collaborators (drizzle, visibility service, the version service's
 * snapshot, helpers) are mocked so this stays a pure-orchestration unit test.
 */

const loadRows: Array<Array<Record<string, unknown>>> = [];

// `executeQuery` backs `loadByIdOrSlug`. We shift a pre-seeded result per call so
// a test can model "exists, then deleted" by queuing [ [row], [] ].
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => loadRows.shift() ?? []),
  executeTransaction: jest.fn(async () => {
    throw new Error("createVersion should not open a transaction directly");
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
  sql: Object.assign((..._a: unknown[]) => ({}), {}),
}));

// The object mapper passes rows straight through for these tests.
jest.mock("@/lib/content/mappers", () => ({
  objectSelectFields: {},
  rowToObjectDTO: (row: Record<string, unknown>) => row,
}));

// Visibility always permits; edit-permission helper is a no-op (permission paths
// are covered by atrium-visibility.test.ts).
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: { canView: jest.fn(async () => true) },
}));
jest.mock("@/lib/content/helpers", () => ({
  actorKindOf: () => "human",
  agentIdOf: () => null,
  assertCanCreate: () => undefined,
  assertCanEdit: () => undefined,
  slugCandidate: () => "s",
  slugifyTitle: () => "s",
  systemUserId: () => 0,
}));

jest.mock("@/lib/content/version-service", () => ({
  snapshotInTx: jest.fn(),
  versionService: { snapshot: jest.fn() },
}));

import { contentService } from "@/lib/content/content-service";
import { versionService } from "@/lib/content/version-service";
import { ConflictError, NotFoundError } from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const snapshot = versionService.snapshot as jest.Mock;

const req: Requester = {
  kind: "user",
  userId: 1,
  roles: ["staff"],
  isAdmin: false,
};

const baseObj = {
  id: "11111111-1111-1111-1111-111111111111",
  kind: "document",
  ownerUserId: 1,
  visibilityLevel: "internal",
  updatedAt: "2026-01-01T00:00:00.000Z",
  currentVersionId: "v0",
};

const newVersion = { id: "v1", versionNumber: 2 };

beforeEach(() => {
  loadRows.length = 0;
  snapshot.mockReset();
});

describe("contentService.createVersion concurrency handling", () => {
  it("retries once on a ConflictError, then succeeds", async () => {
    // load: initial fetch, then post-snapshot reload (object still present).
    loadRows.push([{ ...baseObj }], [{ ...baseObj, updatedAt: "2026-02-02T00:00:00.000Z" }]);
    snapshot
      .mockRejectedValueOnce(new ConflictError("Concurrent version conflict; please retry"))
      .mockResolvedValueOnce(newVersion);

    const result = await contentService.createVersion(req, baseObj.id, {
      body: "# hello",
    });

    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(result.version).toEqual(newVersion);
    expect(result.currentVersionId).toBe("v1");
    // Post-snapshot reload's fresh updatedAt is returned (not the pre-snapshot one).
    expect(result.updatedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("re-throws when the retry also conflicts (sustained contention)", async () => {
    loadRows.push([{ ...baseObj }]);
    snapshot
      .mockRejectedValueOnce(new ConflictError("conflict 1"))
      .mockRejectedValueOnce(new ConflictError("conflict 2"));

    await expect(
      contentService.createVersion(req, baseObj.id, { body: "# hello" })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("throws NotFoundError when the object is deleted before the post-snapshot reload", async () => {
    // load: initial fetch returns the object; reload returns nothing (deleted).
    loadRows.push([{ ...baseObj }], []);
    snapshot.mockResolvedValueOnce(newVersion);

    await expect(
      contentService.createVersion(req, baseObj.id, { body: "# hello" })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});
