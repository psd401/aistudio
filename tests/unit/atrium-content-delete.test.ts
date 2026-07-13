/**
 * Wiring tests for `contentService.delete` (Atrium hard delete).
 *
 * Validates the orchestration + guard ORDER without a real database:
 *  - 404 existence-mask BEFORE any permission signal (assertCanDelete not reached
 *    when the object is not viewable).
 *  - 403 owner/admin gate (assertCanDelete).
 *  - 409 live-publication refusal — both the fast pre-flight AND the authoritative
 *    in-transaction re-check on the locked row (TOCTOU) — never auto-retracts.
 *  - Retrieval-index cleanup (`removeFromIndex`, the sanctioned inverse) runs
 *    BEFORE the delete transaction (the object-delete cascade would otherwise
 *    erase the link that finds the shared repository_item).
 *  - The `delete` audit row is written INSIDE the tx with `details`
 *    (title/kind/owner/versionsDeleted) captured before the row vanishes.
 *  - The object row is deleted (cascade removes children); S3 cleanup runs AFTER
 *    the commit best-effort and an S3 failure does not fail the delete.
 */

const callOrder: string[] = [];
const queryResults: Array<Array<Record<string, unknown>>> = [];
const txSelectQueue: Array<Array<Record<string, unknown>>> = [];
let capturedAuditEntry: Record<string, unknown> | null = null;
const txDeleteCalls: unknown[] = [];

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => queryResults.shift() ?? []),
  executeTransaction: jest.fn(async (cb: (tx: unknown) => unknown) => {
    callOrder.push("tx");
    const tx = {
      select: () => {
        const result = txSelectQueue.shift() ?? [];
        const chain: Record<string, unknown> = {};
        chain.from = () => chain;
        chain.where = () => chain;
        chain.for = () => chain;
        chain.limit = () => Promise.resolve(result);
        chain.then = (
          res: (v: unknown) => unknown,
          rej: (e: unknown) => unknown
        ) => Promise.resolve(result).then(res, rej);
        return chain;
      },
      insert: () => ({
        // The values here are the RETURN of the mocked contentAuditInsertValues
        // (a sentinel). The audit ENTRY is captured by that mock, not here.
        values: (_v: Record<string, unknown>) => Promise.resolve(),
      }),
      delete: () => ({
        where: (w: unknown) => {
          txDeleteCalls.push(w);
          return Promise.resolve();
        },
      }),
    };
    return cb(tx);
  }),
}));
jest.mock("@/lib/db/schema", () => ({
  contentObjects: { id: "id", slug: "slug" },
  contentCollections: {},
  contentVersions: { objectId: "objectId" },
  contentPublications: { objectId: "objectId", status: "status", destination: "destination" },
  contentAuditLogs: {},
  navigationItems: { contentObjectId: "contentObjectId" },
}));
jest.mock("@/lib/db/json-utils", () => ({
  safeJsonbStringify: (v: unknown) => JSON.stringify(v),
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  count: () => "COUNT",
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => a,
  like: (...a: unknown[]) => a,
  sql: Object.assign((..._a: unknown[]) => ({}), { join: () => ({}) }),
}));
jest.mock("@/lib/content/mappers", () => ({
  objectSelectFields: {},
  rowToObjectDTO: (row: Record<string, unknown>) => row,
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const canViewMock = jest.fn(async (..._a: unknown[]) => true);
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: (...a: unknown[]) => canViewMock(...a),
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

const assertCanDeleteMock = jest.fn();
jest.mock("@/lib/content/helpers", () => ({
  actorKindOf: () => "human",
  agentIdOf: () => null,
  authorUserIdOf: () => 7,
  assertCanCreate: jest.fn(),
  assertCanDelete: (...a: unknown[]) => assertCanDeleteMock(...a),
  assertCanEdit: jest.fn(),
  canPublishPublic: () => false,
  persistPublishApprovalRequest: jest.fn(),
  slugCandidate: (b: string) => b,
  slugifyTitle: (t: string) => t,
  systemUserId: () => 999,
}));

jest.mock("@/lib/content/audit", () => ({
  contentAuditInsertValues: (entry: Record<string, unknown>) => {
    capturedAuditEntry = entry;
    return { _auditValues: true };
  },
}));

const removeFromIndexMock = jest.fn(async (_id: string) => {
  callOrder.push("removeFromIndex");
});
jest.mock("@/lib/content/retrieval-service", () => ({
  retrievalService: { removeFromIndex: (id: string) => removeFromIndexMock(id) },
}));

const liveDestinationsMock = jest.fn(async (_id: string) => [] as string[]);
jest.mock("@/lib/content/publish-service", () => ({
  publishService: {
    liveDestinations: (id: string) => liveDestinationsMock(id),
    retractAllPublications: jest.fn(),
  },
}));

const deleteObjectTreeMock = jest.fn(async (_id: string) => {
  callOrder.push("s3");
  return 3;
});
jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: { deleteObjectTree: (id: string) => deleteObjectTreeMock(id) },
  ATRIUM_PREFIX: "atrium",
}));

import { contentService } from "@/lib/content/content-service";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const owner: Requester = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };

const OBJ_ID = "11111111-1111-1111-1111-111111111111";
const baseObj = {
  id: OBJ_ID,
  slug: "my-doc",
  title: "My Doc",
  kind: "document",
  ownerUserId: 7,
  visibilityLevel: "internal",
  status: "draft",
  tags: [],
};

beforeEach(() => {
  callOrder.length = 0;
  queryResults.length = 0;
  txSelectQueue.length = 0;
  txDeleteCalls.length = 0;
  capturedAuditEntry = null;
  canViewMock.mockClear();
  canViewMock.mockResolvedValue(true);
  assertCanDeleteMock.mockClear();
  assertCanDeleteMock.mockReset();
  removeFromIndexMock.mockClear();
  liveDestinationsMock.mockClear();
  liveDestinationsMock.mockResolvedValue([]);
  // Only clear call history — keep the default implementation that records the
  // "s3" call-order marker (mockResolvedValue would discard it).
  deleteObjectTreeMock.mockClear();
});

/** Queue the tx SELECT results for a normal (deletable) object: lock, no live, 3 versions. */
function queueSuccessfulTx() {
  txSelectQueue.push(
    [{ id: OBJ_ID }], // FOR UPDATE lock
    [], // live publications (none)
    [{ value: 3 }] // version count
  );
}

describe("contentService.delete", () => {
  it("404s (NotFound) and never reaches the permission check when not viewable", async () => {
    queryResults.push([{ ...baseObj }]); // loadByIdOrSlug
    canViewMock.mockResolvedValue(false);
    await expect(contentService.delete(owner, OBJ_ID, { surface: "rest" })).rejects.toThrow(
      NotFoundError
    );
    // Existence-mask precedes any permission signal.
    expect(assertCanDeleteMock).not.toHaveBeenCalled();
    expect(removeFromIndexMock).not.toHaveBeenCalled();
  });

  it("404s when the object does not exist", async () => {
    queryResults.push([]); // loadByIdOrSlug → empty
    await expect(contentService.delete(owner, OBJ_ID, { surface: "rest" })).rejects.toThrow(
      NotFoundError
    );
  });

  it("403s (Forbidden) when the requester is not owner/admin", async () => {
    queryResults.push([{ ...baseObj }]);
    assertCanDeleteMock.mockImplementation(() => {
      throw new ForbiddenError("Not permitted to delete this content");
    });
    await expect(contentService.delete(owner, OBJ_ID, { surface: "rest" })).rejects.toThrow(
      ForbiddenError
    );
    expect(removeFromIndexMock).not.toHaveBeenCalled();
  });

  it("409s (Conflict) on the fast pre-flight when a destination is live — never auto-retracts", async () => {
    queryResults.push([{ ...baseObj, status: "published" }]);
    liveDestinationsMock.mockResolvedValue(["intranet"]);
    await expect(
      contentService.delete(owner, OBJ_ID, { surface: "rest" })
    ).rejects.toMatchObject({ status: 409 });
    // Index is NOT pruned and nothing is deleted when the guard blocks.
    expect(removeFromIndexMock).not.toHaveBeenCalled();
    expect(txDeleteCalls).toHaveLength(0);
  });

  it("409s from the AUTHORITATIVE in-tx re-check even if the pre-flight passed (TOCTOU)", async () => {
    queryResults.push([{ ...baseObj }]);
    liveDestinationsMock.mockResolvedValue([]); // pre-flight sees none…
    txSelectQueue.push(
      [{ id: OBJ_ID }], // lock
      [{ destination: "intranet" }] // …but the locked row IS live now
    );
    await expect(
      contentService.delete(owner, OBJ_ID, { surface: "rest" })
    ).rejects.toBeInstanceOf(ConflictError);
    // No audit / no delete when the in-tx guard rejects.
    expect(txDeleteCalls).toHaveLength(0);
  });

  it("deletes: prunes index BEFORE the tx, writes a delete audit with details, deletes the row, cleans S3 after", async () => {
    queryResults.push([{ ...baseObj }]);
    queueSuccessfulTx();

    const result = await contentService.delete(owner, OBJ_ID, { surface: "ui" });

    expect(result).toEqual({
      id: OBJ_ID,
      slug: "my-doc",
      title: "My Doc",
      kind: "document",
      versionsDeleted: 3,
    });

    // Ordering: sanctioned index removal → transaction → S3 cleanup.
    expect(callOrder).toEqual(["removeFromIndex", "tx", "s3"]);

    // Two in-tx deletes: the object's nav entry (NO ACTION FK, not cascaded), then
    // the object row (cascade removes the remaining children).
    expect(txDeleteCalls).toHaveLength(2);

    // The delete audit captured the identity the cascade erases.
    expect(capturedAuditEntry).toMatchObject({
      action: "delete",
      surface: "ui",
      objectId: OBJ_ID,
      outcome: "ok",
      details: {
        title: "My Doc",
        kind: "document",
        ownerUserId: 7,
        versionsDeleted: 3,
      },
    });

    expect(deleteObjectTreeMock).toHaveBeenCalledWith(OBJ_ID);
  });

  it("still succeeds when S3 cleanup fails (best-effort, orphaned keys acceptable)", async () => {
    queryResults.push([{ ...baseObj }]);
    queueSuccessfulTx();
    deleteObjectTreeMock.mockRejectedValueOnce(new Error("s3 boom"));

    const result = await contentService.delete(owner, OBJ_ID, { surface: "rest" });
    expect(result.id).toBe(OBJ_ID);
    // The DB deletes (nav + object) committed regardless of the S3 failure.
    expect(txDeleteCalls).toHaveLength(2);
  });
});
