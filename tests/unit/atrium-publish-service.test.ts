/**
 * Unit tests for publishService.publish (Issue #1051, §15; PR #1062 review #5).
 *
 * Covers the auth / visibility / destination / working-head control flow the
 * publish path must get right before Phase 5 exposes it via REST:
 *  - object not found                       -> NotFoundError
 *  - object exists but not viewable         -> NotFoundError (404, NOT 403 —
 *                                              existence masking for private ids)
 *  - viewable but not editable              -> ForbiddenError (via assertCanEdit)
 *  - public-facing publish, caller lacks publish_public -> ApprovalRequiredError
 *                                              (§26.4 gate); an admin passes it
 *  - unimplemented destination (schoology)  -> ValidationError, hard-blocked
 *                                              BEFORE the tx (no partial write)
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
  title: string;
  collectionId: string | null;
}> = [];

let setLevelInTxCalls = 0;
let lastSetLevelVisibility: unknown = null;
let lastSetLevelExtraSet: unknown = null;
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
    title: "contentObjects.title",
    collectionId: "contentObjects.collectionId",
  },
  contentPublications: {
    id: "contentPublications.id",
    objectId: "contentPublications.objectId",
    destination: "contentPublications.destination",
    publishedVersionId: "contentPublications.publishedVersionId",
    status: "contentPublications.status",
    publishedBy: "contentPublications.publishedBy",
    externalRef: "contentPublications.externalRef",
  },
}));

jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
}));

// publish-service now calls retrievalService.indexObject after a successful
// publish (Phase 6, §16.1). Stub it so this suite doesn't drag in the embedding
// / vector-search stack (ai-helpers → provider-factory → settings-manager);
// the index wiring itself is covered by atrium-retrieval-permission-aware.test.ts.
jest.mock("@/lib/content/retrieval-service", () => ({
  retrievalService: { indexObject: jest.fn(async () => undefined) },
}));

jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: jest.fn(async () => canViewResult),
    // Publish widens visibility via setLevelInTx (the guarded primitive that
    // replaces level + grants atomically); track its invocation + the visibility
    // it received so the happy-path assertions can distinguish "no visibility
    // change" from "group widening".
    setLevelInTx: jest.fn(
      async (
        _tx: unknown,
        _id: unknown,
        visibility: unknown,
        extraSet: unknown
      ) => {
        setLevelInTxCalls += 1;
        lastSetLevelVisibility = visibility;
        lastSetLevelExtraSet = extraSet;
      }
    ),
  },
}));

// The intranet adapter ensures/hides the nav item; track that publish/unpublish
// ran AFTER the transaction.
let adapterPublishCalls = 0;
let adapterUnpublishCalls = 0;
jest.mock("@/lib/content/publish-adapters/intranet", () => ({
  intranetAdapter: {
    destination: "intranet",
    publish: jest.fn(async () => {
      adapterPublishCalls += 1;
      return { externalRef: null };
    }),
    unpublish: jest.fn(async () => {
      adapterUnpublishCalls += 1;
    }),
  },
}));

// A chainable tx stub. The TERMINAL builder methods `.limit()` and `.returning()`
// each shift the next queued result off `txResults` (in call order): a `.limit()`
// terminates a SELECT (the FOR UPDATE lock, the live-publication lookup), and a
// `.returning()` terminates the publication upsert. All other methods
// (`.select()/.update()/.set()/.where()/.for()/.insert()/.values()/.onConflictDoUpdate()`)
// keep the chain fluent. Queue results in the order the awaited terminals run.
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
    // `.limit()` and `.returning()` are the awaited terminals — each yields the
    // next queued result so SELECTs and the upsert RETURNING are deterministic.
    if (prop === "returning" || prop === "limit") return () => nextResult();
    return () => chainProxy;
  },
};
const chainProxy = new Proxy(chain, chainHandler);
const txStub = chainProxy;

import { publishService } from "@/lib/content/publish-service";
import {
  ApprovalRequiredError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const owner: Requester = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };
const stranger: Requester = { kind: "user", userId: 99, roles: ["staff"], isAdmin: false };
const admin: Requester = { kind: "user", userId: 1, roles: ["administrator"], isAdmin: true };

beforeEach(() => {
  publishableRows = [
    {
      ownerUserId: 7,
      visibilityLevel: "private",
      currentVersionId: "v1",
      slug: "s1",
      title: "Doc 1",
      collectionId: null,
    },
  ];
  canViewResult = true;
  setLevelInTxCalls = 0;
  lastSetLevelVisibility = null;
  lastSetLevelExtraSet = null;
  adapterPublishCalls = 0;
  adapterUnpublishCalls = 0;
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
      {
        ownerUserId: 7,
        visibilityLevel: "public",
        currentVersionId: "v1",
        slug: "s1",
        title: "Doc 1",
        collectionId: null,
      },
    ];
    canViewResult = true;
    await expect(
      publishService.publish(stranger, "o1", { destination: "intranet" })
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws ApprovalRequiredError for public_web when the caller lacks publish_public (§26.4 gate)", async () => {
    // The owner is a non-admin staff user with no publish_public capability, so
    // the public-publish gate blocks them with a structured approval signal
    // (surfaces map it to 202 / approval_required), not a hard 403.
    await expect(
      publishService.publish(owner, "o1", { destination: "public_web" })
    ).rejects.toThrow(ApprovalRequiredError);
  });

  it("throws ApprovalRequiredError when widening visibility to public without publish_public", async () => {
    // A visibility widen to `public` is gated INSIDE the transaction against the
    // FOR-UPDATE-locked level (race-free). Seed the lock lookup with a non-public
    // locked row so the widen is a genuine new exposure and the gate fires.
    txResults = [[{ id: "o1", visibilityLevel: "internal" }]];
    await expect(
      publishService.publish(owner, "o1", {
        destination: "intranet",
        visibility: { level: "public" },
      })
    ).rejects.toThrow(ApprovalRequiredError);
    // The gate must reject BEFORE the widen is written — a reorder that ran
    // setLevelInTx first would still throw here but would have already widened.
    expect(setLevelInTxCalls).toBe(0);
  });

  it("does NOT gate a no-op re-publish of ALREADY-public content (idempotent, race-safe)", async () => {
    // The locked row is already public → re-publishing with visibility.level 'public'
    // changes nothing, so a non-admin owner without publish_public passes WITHOUT
    // approval (the #1090 regression), and the check reads the level UNDER the lock.
    txResults = [
      [{ id: "o1", visibilityLevel: "public" }], // FOR UPDATE lock (already public)
      [{ id: "pub1" }], // publication upsert RETURNING
    ];
    await expect(
      publishService.publish(owner, "o1", {
        destination: "intranet",
        visibility: { level: "public" },
      })
    ).resolves.toEqual({ publicationId: "pub1", publishedVersionId: "v1" });
  });

  it("admin past the gate to an unimplemented public destination fails BEFORE any write (no visibility leak)", async () => {
    // An admin passes canPublishPublic, so the §26.4 gate does NOT fire. But
    // public_web is a not-yet-implemented adapter, so the publish must be blocked
    // BEFORE the transaction — NOT proceed through it and only fail at the adapter
    // afterward. Regression guard for the leak where the tx committed
    // visibilityLevel="public" (world-readable via canView) before the adapter
    // threw, leaving the object public despite the publish "failing". Queue tx
    // results so that IF the tx wrongly ran, it would not crash for the wrong
    // reason — the assertions below prove it never ran.
    txResults = [[{ id: "o1" }], [{ id: "pub1" }]];
    await expect(
      publishService.publish(admin, "o1", {
        destination: "public_web",
        visibility: { level: "public" },
      })
    ).rejects.toThrow(ValidationError);
    // The exact leak this fix closes: visibility was NEVER widened in a tx...
    expect(setLevelInTxCalls).toBe(0);
    // ...and the (no-op) adapter side effect never ran either.
    expect(adapterPublishCalls).toBe(0);
  });

  it("throws ValidationError for an unimplemented destination (schoology), before the tx", async () => {
    // schoology is not public-facing (no gate), but its adapter is not yet
    // implemented, so the publish is hard-blocked BEFORE the transaction runs.
    txResults = [[{ id: "o1" }], [{ id: "pub1" }]];
    await expect(
      publishService.publish(owner, "o1", { destination: "schoology" })
    ).rejects.toThrow(ValidationError);
    expect(setLevelInTxCalls).toBe(0);
    expect(adapterPublishCalls).toBe(0);
  });

  it("throws ValidationError when there is no working head", async () => {
    publishableRows = [
      {
        ownerUserId: 7,
        visibilityLevel: "private",
        currentVersionId: null,
        slug: "s1",
        title: "Doc 1",
        collectionId: null,
      },
    ];
    await expect(
      publishService.publish(owner, "o1", { destination: "intranet" })
    ).rejects.toThrow(ValidationError);
  });

  it("resolves and runs the adapter AFTER the tx on the happy path", async () => {
    // tx queue: FOR UPDATE lock row, then the publication upsert RETURNING id.
    txResults = [[{ id: "o1" }], [{ id: "pub1" }]];
    const result = await publishService.publish(owner, "o1", {
      destination: "intranet",
    });
    expect(result).toEqual({ publicationId: "pub1", publishedVersionId: "v1" });
    expect(adapterPublishCalls).toBe(1);
    // No visibility provided -> setLevelInTx must NOT run (publish doesn't widen).
    expect(setLevelInTxCalls).toBe(0);
  });

  it("widens visibility via setLevelInTx only when visibility is provided", async () => {
    // tx queue: FOR UPDATE lock row, then the publication upsert RETURNING id.
    txResults = [[{ id: "o1" }], [{ id: "pub2" }]];
    await publishService.publish(owner, "o1", {
      destination: "intranet",
      visibility: { level: "group", grants: [{ kind: "role", value: "staff" }] },
    });
    expect(setLevelInTxCalls).toBe(1);
    // The full visibility input (level + grants) is forwarded to the guarded
    // primitive, which replaces the level and grants atomically in the tx.
    expect(lastSetLevelVisibility).toEqual({
      level: "group",
      grants: [{ kind: "role", value: "staff" }],
    });
    // The `status: "published"` write is folded into setLevelInTx's single level
    // UPDATE (via extraSet) rather than issued as a redundant second UPDATE on the
    // same row in the same transaction.
    expect(lastSetLevelExtraSet).toEqual({ status: "published" });
  });

  it("throws ValidationError when the upsert returns no row", async () => {
    // tx queue: FOR UPDATE lock row (found), then the upsert RETURNING yields [].
    txResults = [[{ id: "o1" }], []];
    await expect(
      publishService.publish(owner, "o1", { destination: "intranet" })
    ).rejects.toThrow(ValidationError);
  });
});

describe("publishService.unpublish", () => {
  it("throws NotFoundError when the object does not exist", async () => {
    publishableRows = [];
    await expect(
      publishService.unpublish(owner, "o1", "intranet")
    ).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError (not ForbiddenError) when not viewable (existence masking)", async () => {
    canViewResult = false;
    await expect(
      publishService.unpublish(stranger, "o1", "intranet")
    ).rejects.toThrow(NotFoundError);
  });

  it("throws ForbiddenError when viewable but not owner/admin", async () => {
    publishableRows = [
      {
        ownerUserId: 7,
        visibilityLevel: "public",
        currentVersionId: "v1",
        slug: "s1",
        title: "Doc 1",
        collectionId: null,
      },
    ];
    canViewResult = true;
    await expect(
      publishService.unpublish(stranger, "o1", "intranet")
    ).rejects.toThrow(ForbiddenError);
  });

  it("is a no-op (unpublished:false) and does NOT run the adapter when there is no live publication", async () => {
    // tx queue: FOR UPDATE lock row, then the live-publication lookup returns [].
    txResults = [[{ id: "o1" }], []];
    const result = await publishService.unpublish(owner, "o1", "intranet");
    expect(result).toEqual({ unpublished: false });
    expect(adapterUnpublishCalls).toBe(0);
  });

  it("marks unpublished and runs the adapter teardown AFTER the tx on the happy path", async () => {
    // tx queue: FOR UPDATE lock row, then a live publication row with externalRef.
    txResults = [[{ id: "o1" }], [{ id: "pub1", externalRef: null }]];
    const result = await publishService.unpublish(owner, "o1", "intranet");
    expect(result).toEqual({ unpublished: true });
    expect(adapterUnpublishCalls).toBe(1);
  });

  // §26.4 — taking a public destination offline requires the same authority as
  // putting it up: content:publish_internal alone must not be enough to tear
  // down already-live public_web content.
  it("throws ApprovalRequiredError unpublishing public_web without publish_public, and never touches the tx", async () => {
    await expect(
      publishService.unpublish(owner, "o1", "public_web")
    ).rejects.toThrow(ApprovalRequiredError);
    expect(adapterUnpublishCalls).toBe(0);
  });

  it("allows unpublishing public_web for an admin", async () => {
    txResults = [[{ id: "o1" }], [{ id: "pub1", externalRef: null }]];
    const result = await publishService.unpublish(admin, "o1", "public_web");
    expect(result).toEqual({ unpublished: true });
  });

  it("allows unpublishing public_web when the caller has an explicit publish_public capability", async () => {
    txResults = [[{ id: "o1" }], [{ id: "pub1", externalRef: null }]];
    const result = await publishService.unpublish(owner, "o1", "public_web", {
      hasPublishPublicCapability: true,
    });
    expect(result).toEqual({ unpublished: true });
  });
});
