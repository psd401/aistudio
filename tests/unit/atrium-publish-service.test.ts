/**
 * Unit tests for publishService.publish (Issue #1051, §15; PR #1062 review #5).
 *
 * Covers the auth / visibility / destination / working-head control flow the
 * publish path must get right before Phase 5 exposes it via REST:
 *  - object not found                       -> NotFoundError
 *  - object exists but not viewable         -> NotFoundError (404, NOT 403 —
 *                                              existence masking for private ids)
 *  - viewable but not editable              -> ForbiddenError (via assertCanEdit)
 *  - destination public_web                 -> ForbiddenError (later phase)
 *  - unimplemented destination (schoology)  -> ValidationError (adapter throws)
 *  - no working head (currentVersionId null) -> ValidationError
 *  - happy path                              -> resolves with ids; applyGrants is
 *                                              only called for group visibility
 *
 * The permission checks + the publishable load run OUTSIDE the transaction (via
 * executeQuery); the status/publication upsert runs INSIDE executeTransaction.
 * Both are mocked so each path is driven deterministically without a database.
 */

// --- mocks (hoisted above imports by jest) ---

// executeQuery serves loadPublishable; the test sets `publishableRows`.
let publishableRows: Array<{
  ownerUserId: number;
  visibilityLevel: string;
  currentVersionId: string | null;
  slug: string;
}> = [];

let applyGrantsCalls = 0;
let canViewResult = true;

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => publishableRows),
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
    slug: "contentObjects.slug",
  },
  contentPublications: {
    id: "contentPublications.id",
    objectId: "contentPublications.objectId",
    destination: "contentPublications.destination",
    publishedVersionId: "contentPublications.publishedVersionId",
    status: "contentPublications.status",
    publishedBy: "contentPublications.publishedBy",
  },
}));

jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
}));

jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: jest.fn(async () => canViewResult),
    applyGrants: jest.fn(async () => {
      applyGrantsCalls += 1;
    }),
  },
}));

// The intranet adapter is a no-op; track that it ran AFTER the transaction.
let adapterPublishCalls = 0;
jest.mock("@/lib/content/publish-adapters/intranet", () => ({
  intranetAdapter: {
    destination: "intranet",
    publish: jest.fn(async () => {
      adapterPublishCalls += 1;
      return { externalRef: null };
    }),
  },
}));

// A chainable tx stub. Terminal `.returning()` shifts the next queued result off
// `txResults` (the publication upsert RETURNING id); `.update()/.set()/.where()`
// and `.insert()/.values()/.onConflictDoUpdate()` keep the chain fluent.
let txResults: unknown[] = [];
function nextResult(): unknown {
  return txResults.shift() ?? [];
}
const chain: Record<string, unknown> = {};
const chainHandler: ProxyHandler<Record<string, unknown>> = {
  get(_t, prop: string | symbol) {
    // `await tx.update(...)...where(...)` awaits the chain proxy itself; if the
    // proxy returned a function for `then`, JS would treat it as a never-resolving
    // thenable. Return undefined for `then` so awaiting the chain resolves to it.
    if (prop === "then") return undefined;
    if (prop === "returning") return () => nextResult();
    return () => chainProxy;
  },
};
const chainProxy = new Proxy(chain, chainHandler);
const txStub = chainProxy;

import { publishService } from "@/lib/content/publish-service";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const owner: Requester = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };
const stranger: Requester = { kind: "user", userId: 99, roles: ["staff"], isAdmin: false };

beforeEach(() => {
  publishableRows = [
    { ownerUserId: 7, visibilityLevel: "private", currentVersionId: "v1", slug: "s1" },
  ];
  canViewResult = true;
  applyGrantsCalls = 0;
  adapterPublishCalls = 0;
  txResults = [];
  jest.clearAllMocks();
});

describe("publishService.publish", () => {
  it("throws NotFoundError when the object does not exist", async () => {
    publishableRows = [];
    await expect(
      publishService.publish(owner, "o1", { destination: "intranet" })
    ).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError (not ForbiddenError) when not viewable (existence masking)", async () => {
    canViewResult = false;
    await expect(
      publishService.publish(stranger, "o1", { destination: "intranet" })
    ).rejects.toThrow(NotFoundError);
  });

  it("throws ForbiddenError when viewable but not owner/admin", async () => {
    publishableRows = [
      { ownerUserId: 7, visibilityLevel: "public", currentVersionId: "v1", slug: "s1" },
    ];
    canViewResult = true;
    await expect(
      publishService.publish(stranger, "o1", { destination: "intranet" })
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws ForbiddenError for the public_web destination (later phase)", async () => {
    await expect(
      publishService.publish(owner, "o1", { destination: "public_web" })
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws ValidationError for an unimplemented destination (schoology)", async () => {
    txResults = [[{ id: "pub1" }]];
    await expect(
      publishService.publish(owner, "o1", { destination: "schoology" })
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError when there is no working head", async () => {
    publishableRows = [
      { ownerUserId: 7, visibilityLevel: "private", currentVersionId: null, slug: "s1" },
    ];
    await expect(
      publishService.publish(owner, "o1", { destination: "intranet" })
    ).rejects.toThrow(ValidationError);
  });

  it("resolves and runs the adapter AFTER the tx on the happy path", async () => {
    txResults = [[{ id: "pub1" }]];
    const result = await publishService.publish(owner, "o1", {
      destination: "intranet",
    });
    expect(result).toEqual({ publicationId: "pub1", publishedVersionId: "v1" });
    expect(adapterPublishCalls).toBe(1);
    // No group visibility provided -> applyGrants must NOT run.
    expect(applyGrantsCalls).toBe(0);
  });

  it("applies grants only when group visibility is provided", async () => {
    txResults = [[{ id: "pub2" }]];
    await publishService.publish(owner, "o1", {
      destination: "intranet",
      visibility: { level: "group", grants: [{ kind: "role", value: "staff" }] },
    });
    expect(applyGrantsCalls).toBe(1);
  });

  it("throws ValidationError when the upsert returns no row", async () => {
    txResults = [[]]; // RETURNING yields nothing
    await expect(
      publishService.publish(owner, "o1", { destination: "intranet" })
    ).rejects.toThrow(ValidationError);
  });
});
