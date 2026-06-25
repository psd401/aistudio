/**
 * Unit tests for versionService.rollback (Issue #1058, §14).
 *
 * Covers the non-obvious control-flow paths the rollback head-advance has to get
 * right before Phase 5 exposes it via REST:
 *  - object not found                       -> NotFoundError
 *  - object exists but not viewable         -> NotFoundError (404, NOT 403 —
 *                                              existence masking for private ids)
 *  - viewable but not editable              -> ForbiddenError
 *  - target version belongs to a different object -> ValidationError
 *  - object concurrently deleted (UPDATE affects 0 rows) -> NotFoundError
 *  - happy path advances the head           -> resolves
 *
 * The permission checks run OUTSIDE the transaction (via executeQuery) and the
 * head-advance runs INSIDE executeTransaction. Both are mocked so each path can
 * be driven deterministically without a database. The tx object is a chainable
 * query-builder stub whose terminal `.limit()` / `.returning()` return the value
 * the test queued for that step.
 */

// --- mocks (hoisted above imports by jest) ---

// executeQuery: the rollback owner-load (`content.rollback.loadOwner`). The test
// sets `ownerLoadResult` to the array the query should resolve to.
let ownerLoadResult: Array<{ ownerUserId: number; visibilityLevel: string }> = [];
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => ownerLoadResult),
  // executeTransaction runs the callback with a tx stub the test configures.
  executeTransaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(txStub)
  ),
}));

jest.mock("@/lib/db/schema", () => ({
  contentObjects: {
    id: "contentObjects.id",
    ownerUserId: "contentObjects.ownerUserId",
    visibilityLevel: "contentObjects.visibilityLevel",
    currentVersionId: "contentObjects.currentVersionId",
    updatedAt: "contentObjects.updatedAt",
  },
  contentVersions: {
    id: "contentVersions.id",
    objectId: "contentVersions.objectId",
  },
}));
jest.mock("@/lib/db/drizzle-helpers", () => ({
  pgTimestampAsText: (c: unknown) => c,
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => a,
  sql: Object.assign((..._a: unknown[]) => ({}), {}),
}));
jest.mock("@/lib/content/render/markdown-render", () => ({
  renderMarkdownToHtml: () => "<p>unused</p>",
}));
jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: { key: () => "k", putText: () => undefined },
}));

// visibilityService.canView is the only collaborator method rollback calls; the
// test toggles `canViewResult` per case.
let canViewResult = true;
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: jest.fn(async () => canViewResult),
  },
}));

// A chainable tx stub. Each query step ends in `.limit()` (the SELECTs) or
// `.returning()` (the UPDATE); those terminals shift the next queued result off
// `txResults`. The order rollback issues them: 1) target-version SELECT,
// 2) head-advance UPDATE returning.
let txResults: unknown[] = [];
function nextResult(): unknown {
  return txResults.shift() ?? [];
}
const chain: Record<string, unknown> = {};
const chainHandler: ProxyHandler<Record<string, unknown>> = {
  get(_t, prop: string) {
    if (prop === "limit" || prop === "returning") {
      return () => nextResult();
    }
    // select/from/where/set/update/delete/insert/values/orderBy/offset all
    // return the chain so the builder keeps fluently chaining.
    return () => chainProxy;
  },
};
const chainProxy = new Proxy(chain, chainHandler);
const txStub = chainProxy;

import { versionService } from "@/lib/content/version-service";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const owner: Requester = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };
const stranger: Requester = { kind: "user", userId: 99, roles: ["staff"], isAdmin: false };

beforeEach(() => {
  ownerLoadResult = [{ ownerUserId: 7, visibilityLevel: "private" }];
  canViewResult = true;
  txResults = [];
  jest.clearAllMocks();
});

describe("versionService.rollback", () => {
  it("throws NotFoundError when the object does not exist", async () => {
    ownerLoadResult = [];
    await expect(versionService.rollback(owner, "o1", "v1")).rejects.toThrow(
      NotFoundError
    );
  });

  it("throws NotFoundError (not ForbiddenError) when the object is not viewable", async () => {
    // Existence masking: a non-viewable private object must 404, never 403,
    // so an attacker cannot enumerate private ids.
    canViewResult = false;
    await expect(
      versionService.rollback(stranger, "o1", "v1")
    ).rejects.toThrow(NotFoundError);
  });

  it("throws ForbiddenError when viewable but not the owner/admin", async () => {
    // Public object: viewable by anyone, but only owner/admin may edit.
    ownerLoadResult = [{ ownerUserId: 7, visibilityLevel: "public" }];
    canViewResult = true;
    await expect(
      versionService.rollback(stranger, "o1", "v1")
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws ValidationError when the target version belongs to another object", async () => {
    // target-version SELECT returns empty (no row matching id AND objectId).
    txResults = [[]];
    await expect(versionService.rollback(owner, "o1", "vWrong")).rejects.toThrow(
      ValidationError
    );
  });

  it("throws NotFoundError when the object is concurrently deleted (UPDATE affects 0 rows)", async () => {
    // 1) target SELECT finds the version; 2) UPDATE returning is empty (row gone).
    txResults = [[{ id: "v1" }], []];
    await expect(versionService.rollback(owner, "o1", "v1")).rejects.toThrow(
      NotFoundError
    );
  });

  it("resolves when the owner rolls back to a valid target version", async () => {
    // 1) target SELECT finds the version; 2) UPDATE returning the object row.
    txResults = [[{ id: "v1" }], [{ id: "o1" }]];
    await expect(
      versionService.rollback(owner, "o1", "v1")
    ).resolves.toBeUndefined();
  });
});
