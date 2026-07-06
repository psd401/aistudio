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
  // Runs the query builder against a recording proxy (`setRecorder`) so the
  // post-commit `.set({ externalRef })` UPDATE (persist-external-ref) payload can
  // be asserted, then resolves to `publishableRows` exactly as before —
  // loadPublishable is unaffected; only side-effect capture is added.
  executeQuery: jest.fn(async (cb?: (db: unknown) => unknown) => {
    if (typeof cb === "function") {
      try {
        cb(setRecorder);
      } catch {
        // A builder against a fluent proxy never throws; guard defensively so a
        // future callback shape can't break the (unchanged) return value.
      }
    }
    return publishableRows;
  }),
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
// publish (Phase 6, §16.1) and retrievalService.removeFromIndex after an
// unpublish that leaves NO destination live (index pruning). Stub both so this
// suite doesn't drag in the embedding / vector-search stack (ai-helpers →
// provider-factory → settings-manager); the index/prune internals are covered by
// atrium-retrieval-permission-aware.test.ts / atrium-retrieval-index-pruning.test.ts.
const removeFromIndexMock = jest.fn(async (_objectId: string) => undefined);
jest.mock("@/lib/content/retrieval-service", () => ({
  retrievalService: {
    indexObject: jest.fn(async () => undefined),
    // Deref the outer mock lazily (jest.mock factories are hoisted above the
    // const declaration — a direct reference is a TDZ error).
    removeFromIndex: (objectId: string) => removeFromIndexMock(objectId),
  },
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
// When true, the intranet adapter teardown throws — used to prove the retrieval
// index is pruned BEFORE the teardown (#4), so a teardown failure can't strand
// the index un-pruned.
let adapterUnpublishThrows = false;
jest.mock("@/lib/content/publish-adapters/intranet", () => ({
  intranetAdapter: {
    destination: "intranet",
    publish: jest.fn(async () => {
      adapterPublishCalls += 1;
      return { externalRef: null };
    }),
    unpublish: jest.fn(async () => {
      adapterUnpublishCalls += 1;
      if (adapterUnpublishThrows) throw new Error("nav hide boom");
    }),
  },
}));

// The public_web adapter (Phase 7, #1057) is LIVE and reader-backed: it returns
// the anonymous reader URL to persist as external_ref. Mock it (instead of loading
// the real module, which pulls surface-helpers → @/utils/roles) and record the
// slug it received + the ref it returned so the happy-path assertions can verify
// the ref round-trips.
const PUBLIC_WEB_REF = "https://pub.example/p/s1";
let publicWebPublishCalls = 0;
let lastPublicWebSlug: string | null = null;
jest.mock("@/lib/content/publish-adapters/public-web", () => ({
  publicWebAdapter: {
    destination: "public_web",
    publish: jest.fn(async ({ slug }: { slug: string }) => {
      publicWebPublishCalls += 1;
      lastPublicWebSlug = slug;
      return { externalRef: PUBLIC_WEB_REF };
    }),
  },
}));

// Schoology/Google are governed connector STUBS (implemented: false); their
// publish throws BEFORE the tx. Mock them so the registry resolves without loading
// the real modules and so the stub-throw path is deterministic.
jest.mock("@/lib/content/publish-adapters/schoology", () => ({
  schoologyAdapter: {
    destination: "schoology",
    implemented: false,
    publish: jest.fn(async () => {
      throw new Error("schoology stub should never run");
    }),
  },
}));
jest.mock("@/lib/content/publish-adapters/google", () => ({
  googleAdapter: {
    destination: "google",
    implemented: false,
    publish: jest.fn(async () => {
      throw new Error("google stub should never run");
    }),
  },
}));

// The okf adapter (Phase 8, #1103) serializes a single object to a portable OKF
// bundle. The REAL module imports content-service (→ mappers → drizzle-helpers,
// which needs `sql`, not in this suite's minimal drizzle-orm mock), so mock it to
// a light stub — this suite never publishes to okf.
jest.mock("@/lib/content/publish-adapters/okf", () => ({
  okfAdapter: {
    destination: "okf",
    publish: jest.fn(async () => ({ externalRef: null })),
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
// Records the payload of every `.set({...})` executed inside the transaction (in
// call order) so a test can assert WHICH updates ran — e.g. that unpublishing one
// destination flips the publication to `unpublished` but only downgrades the object
// to `draft` when no other destination is still live (Phase 7, #1057).
let txSetPayloads: Array<Record<string, unknown>> = [];
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
    // `.set(payload)` records the update payload, then stays fluent.
    if (prop === "set")
      return (payload: Record<string, unknown>) => {
        txSetPayloads.push(payload);
        return chainProxy;
      };
    return () => chainProxy;
  },
};
const chainProxy = new Proxy(chain, chainHandler);
const txStub = chainProxy;

// A recording proxy for `executeQuery` builders (which run OUTSIDE the tx, e.g.
// the persist-external-ref UPDATE). Every builder method stays fluent; `.set`
// additionally captures its payload so a test can assert the exact value that
// round-trips into `.set({ externalRef })` — not merely that the labelled call
// happened. Only the persist-external-ref UPDATE (and, on failure, mark-failed)
// call `.set` via executeQuery, so `lastSetPayload` unambiguously holds the last
// such payload.
let lastSetPayload: Record<string, unknown> | null = null;
const setRecorder: unknown = new Proxy(
  {},
  {
    get(_t, prop: string | symbol) {
      if (prop === "then") return undefined;
      if (prop === "set")
        return (payload: Record<string, unknown>) => {
          lastSetPayload = payload;
          return setRecorder;
        };
      return () => setRecorder;
    },
  }
);

import { publishService } from "@/lib/content/publish-service";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  ApprovalRequiredError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const executeQueryMock = executeQuery as unknown as jest.Mock;

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
  adapterUnpublishThrows = false;
  publicWebPublishCalls = 0;
  lastPublicWebSlug = null;
  lastSetPayload = null;
  txSetPayloads = [];
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

  it("admin past the gate to an unimplemented (stub) public destination fails BEFORE any write (no visibility leak)", async () => {
    // An admin passes canPublishPublic, so the §26.4 gate does NOT fire. But
    // schoology is a not-yet-implemented connector stub, so the publish must be
    // blocked BEFORE the transaction — NOT proceed through it and only fail at the
    // adapter afterward. Regression guard for the leak where the tx committed
    // visibilityLevel="public" (world-readable via canView) before the adapter
    // threw, leaving the object public despite the publish "failing". Queue tx
    // results so that IF the tx wrongly ran, it would not crash for the wrong
    // reason — the assertions below prove it never ran. (public_web is now LIVE, so
    // a stub destination is used to preserve this exact regression guard.)
    txResults = [[{ id: "o1" }], [{ id: "pub1" }]];
    await expect(
      publishService.publish(admin, "o1", {
        destination: "schoology",
        visibility: { level: "public" },
      })
    ).rejects.toThrow(ValidationError);
    // The exact leak this fix closes: visibility was NEVER widened in a tx...
    expect(setLevelInTxCalls).toBe(0);
    // ...and no adapter side effect ran either.
    expect(adapterPublishCalls).toBe(0);
    expect(publicWebPublishCalls).toBe(0);
  });

  it("gates schoology/google behind the §26.4 public gate for an unauthorized caller (Phase 7)", async () => {
    // Phase 7 (#1057): schoology & google are PUBLIC (family-facing) destinations
    // now, so a non-admin owner without publish_public is routed through the
    // approval gate — BEFORE the not-implemented check — exactly like public_web.
    for (const destination of ["schoology", "google"] as const) {
      await expect(
        publishService.publish(owner, "o1", { destination })
      ).rejects.toThrow(ApprovalRequiredError);
    }
    expect(setLevelInTxCalls).toBe(0);
    expect(adapterPublishCalls).toBe(0);
  });

  it("an authorized caller (admin) past the gate hits the stub ValidationError BEFORE the tx (no write)", async () => {
    // An admin passes the §26.4 gate, then the schoology/google connector STUB
    // (implemented: false) blocks BEFORE the transaction — no publication row and
    // no visibility widen is written for a not-yet-wired connector.
    for (const destination of ["schoology", "google"] as const) {
      txResults = [[{ id: "o1" }], [{ id: "pub1" }]];
      await expect(
        publishService.publish(admin, "o1", { destination })
      ).rejects.toThrow(ValidationError);
    }
    expect(setLevelInTxCalls).toBe(0);
    expect(adapterPublishCalls).toBe(0);
  });

  it("publishes public_web LIVE for an admin, runs the adapter, and persists its external_ref (Phase 7)", async () => {
    // public_web is now a live reader-backed adapter. An admin passes the gate;
    // the publish commits, the adapter returns the anonymous reader URL, and the
    // service persists it as external_ref via a follow-up UPDATE.
    txResults = [[{ id: "o1" }], [{ id: "pub1" }]];
    const result = await publishService.publish(admin, "o1", {
      destination: "public_web",
    });
    expect(result).toEqual({ publicationId: "pub1", publishedVersionId: "v1" });
    // The public_web adapter ran with the object's slug and returned the URL.
    expect(publicWebPublishCalls).toBe(1);
    expect(lastPublicWebSlug).toBe("s1");
    // The returned external_ref is persisted via a dedicated UPDATE (labelled), so
    // the publication row records WHERE the version went live.
    expect(
      executeQueryMock.mock.calls.some(
        (call: unknown[]) => call[1] === "publish.persistExternalRef"
      )
    ).toBe(true);
    // And the EXACT ref the adapter returned round-trips into the UPDATE payload
    // (not merely that the labelled call fired) — guards a future regression that
    // persists a wrong/stale value.
    expect(lastSetPayload?.externalRef).toBe(PUBLIC_WEB_REF);
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

  it("prunes the retrieval index BEFORE the adapter teardown (#4 — teardown failure can't strand the index)", async () => {
    // No other destination live → the object goes fully offline, so the index
    // must be pruned. The teardown then throws; the prune must already have run
    // (a retry would idempotently no-op at the `status='live'` filter and never
    // reach a prune placed after the teardown).
    adapterUnpublishThrows = true;
    txResults = [[{ id: "o1" }], [{ id: "pub1", externalRef: null }]];
    await expect(
      publishService.unpublish(owner, "o1", "intranet")
    ).rejects.toThrow(/nav hide boom/);
    expect(removeFromIndexMock).toHaveBeenCalledWith("o1");
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

  // Phase 7 (#1057): schoology & google are public-facing, so unpublishing them
  // requires the same §26.4 authority as public_web.
  it("throws ApprovalRequiredError unpublishing schoology/google without publish_public", async () => {
    for (const destination of ["schoology", "google"] as const) {
      await expect(
        publishService.unpublish(owner, "o1", destination)
      ).rejects.toThrow(ApprovalRequiredError);
    }
    expect(adapterUnpublishCalls).toBe(0);
  });

  // Phase 7 (#1057): public_web is now a live adapter, so an object can be live on
  // multiple destinations at once. Unpublishing one must NOT downgrade the object
  // to draft while another destination still serves it.
  it("does NOT revert the object to draft when another destination is still live", async () => {
    // tx queue: FOR UPDATE lock, the live public_web row being torn down, then the
    // "any other destination still live?" check returns a row (intranet live).
    txResults = [
      [{ id: "o1" }],
      [{ id: "pub1", externalRef: null }],
      [{ id: "pub-intranet" }],
    ];
    const result = await publishService.unpublish(admin, "o1", "public_web");
    expect(result).toEqual({ unpublished: true });
    const statuses = txSetPayloads.map((p) => p.status);
    // The publication was flipped to unpublished, but the object status was NOT
    // downgraded to draft (intranet remains live).
    expect(statuses).toContain("unpublished");
    expect(statuses).not.toContain("draft");
    // The retrieval index is KEPT while any destination is still live — the
    // content is still published somewhere and must remain retrievable.
    expect(removeFromIndexMock).not.toHaveBeenCalled();
  });

  it("prunes the retrieval index only when the last live destination is removed", async () => {
    // tx queue: FOR UPDATE lock, the live row being torn down, then the
    // "any other destination still live?" check returns [] (none remain).
    txResults = [[{ id: "o1" }], [{ id: "pub1", externalRef: null }], []];
    const result = await publishService.unpublish(admin, "o1", "public_web");
    expect(result).toEqual({ unpublished: true });
    expect(removeFromIndexMock).toHaveBeenCalledTimes(1);
    expect(removeFromIndexMock).toHaveBeenCalledWith("o1");
  });

  it("does NOT prune the index on the idempotent no-op path (nothing was live)", async () => {
    txResults = [[{ id: "o1" }], []];
    const result = await publishService.unpublish(owner, "o1", "intranet");
    expect(result).toEqual({ unpublished: false });
    expect(removeFromIndexMock).not.toHaveBeenCalled();
  });

  it("a prune failure is best-effort: the unpublish still succeeds", async () => {
    removeFromIndexMock.mockRejectedValueOnce(new Error("index prune boom"));
    txResults = [[{ id: "o1" }], [{ id: "pub1", externalRef: null }], []];
    const result = await publishService.unpublish(admin, "o1", "public_web");
    // The unpublish already committed; a failed index prune is logged, not thrown.
    expect(result).toEqual({ unpublished: true });
  });

  it("reverts the object to draft when the unpublished destination was the last live one", async () => {
    // tx queue: FOR UPDATE lock, the live row being torn down, then the
    // "any other destination still live?" check returns [] (none remain).
    txResults = [[{ id: "o1" }], [{ id: "pub1", externalRef: null }], []];
    const result = await publishService.unpublish(admin, "o1", "public_web");
    expect(result).toEqual({ unpublished: true });
    const statuses = txSetPayloads.map((p) => p.status);
    expect(statuses).toContain("unpublished");
    expect(statuses).toContain("draft");
  });
});
