/**
 * Unit tests for publishService.publish (Issue #1051, §15; PR #1062 review #5).
 *
 * Covers the auth / visibility / destination / working-head control flow the
 * publish path must get right before Phase 5 exposes it via REST:
 *  - object not found                       -> NotFoundError
 *  - object exists but not viewable         -> NotFoundError (404, NOT 403 —
 *                                              existence masking for private ids)
 *  - viewable but not editable              -> ForbiddenError (via assertCanEdit)
 *  - CONNECTOR publish, caller lacks publish_public -> ApprovalRequiredError
 *                                              (§26.4 gate); an admin passes it
 *  - the live switch NEVER touches visibility (#1726) — the audience is the
 *    object's Level, written only by visibilityService.setLevel
 *  - unimplemented destination (schoology)  -> ValidationError, hard-blocked
 *                                              BEFORE the tx (no partial write)
 *  - no working head (currentVersionId null) -> ValidationError
 *  - happy path                              -> resolves with ids
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

// executeQuery also serves the unpublish pre-gate live-publication check (issue
// #1118 P2). Default: a live publication exists, so the unpublish gate/tx run;
// set to [] to model an already-offline destination (the pre-gate no-op).
let liveCheckRows: Array<{ id: string }> = [{ id: "pub-live" }];

let setLevelInTxCalls = 0;
let canViewResult = true;

jest.mock("@/lib/db/drizzle-client", () => ({
  // Runs the query builder against a recording proxy (`setRecorder`) so the
  // post-commit `.set({ externalRef })` UPDATE (persist-external-ref) payload can
  // be asserted, then resolves to `publishableRows` exactly as before —
  // loadPublishable is unaffected; only side-effect capture is added.
  executeQuery: jest.fn(async (cb?: (db: unknown) => unknown, label?: string) => {
    if (typeof cb === "function") {
      try {
        cb(setRecorder);
      } catch {
        // A builder against a fluent proxy never throws; guard defensively so a
        // future callback shape can't break the (unchanged) return value.
      }
    }
    // The unpublish pre-gate live-publication check (issue #1118 P2) reads its own
    // configurable result; every other executeQuery (loadPublishable, …) is unchanged.
    if (label === "publish.unpublish.liveCheck") return liveCheckRows;
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
  // `unpublish` retires EVERY live-surface row (#1726), so its lookups and its
  // status flip are `inArray`-shaped. Rendered as a plain tuple like `eq`, so
  // `txWhereClauses` assertions can still scan the flattened conditions.
  inArray: (...a: unknown[]) => a,
}));

// publish-service now calls retrievalService.indexObject after a successful
// publish (Phase 6, §16.1) and retrievalService.removeFromIndex after an
// unpublish that leaves NO destination live (index pruning). Stub both so this
// suite doesn't drag in the embedding / vector-search stack (ai-helpers →
// provider-factory → settings-manager); the index/prune internals are covered by
// atrium-retrieval-permission-aware.test.ts / atrium-retrieval-index-pruning.test.ts.
const removeFromIndexMock = jest.fn(async (_objectId: string) => undefined);
const indexObjectMock = jest.fn(
  async (_objectId: string, _versionId?: string) => undefined
);
jest.mock("@/lib/content/retrieval-service", () => ({
  retrievalService: {
    // Deref the outer mocks lazily (jest.mock factories are hoisted above the
    // const declarations — a direct reference is a TDZ error).
    indexObject: (objectId: string, versionId?: string) =>
      indexObjectMock(objectId, versionId),
    removeFromIndex: (objectId: string) => removeFromIndexMock(objectId),
  },
}));

jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: jest.fn(async () => canViewResult),
    // `setLevelInTx` is the guarded primitive that replaces an object's level
    // AND its grants atomically. Publishing must NEVER call it (#1726) — that
    // call is exactly how publishing used to wipe an author's grant set — so the
    // assertions only need to know whether it ran at all.
    setLevelInTx: jest.fn(async () => {
      setLevelInTxCalls += 1;
    }),
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

// The public_web adapter is registered but UNREACHABLE since #1726:
// `normalizeLiveDestination` folds `public_web` onto the live intranet row before
// the registry is consulted. Mocked (instead of loading the real module, which
// pulls surface-helpers → @/utils/roles) with a call counter, so a regression
// that resurrected a second live row would show up as a non-zero count.
let publicWebPublishCalls = 0;
jest.mock("@/lib/content/publish-adapters/public-web", () => ({
  publicWebAdapter: {
    destination: "public_web",
    publish: jest.fn(async () => {
      publicWebPublishCalls += 1;
      return { externalRef: "https://pub.example/p/s1" };
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

// publish-service imports versionService (to validate a PINNED version on the
// approval-replay path — issue #1118). The REAL module pulls mappers →
// drizzle-helpers, which needs `sql` (not in this suite's minimal drizzle-orm
// mock), so stub it. `getById` returns a version by default so a `versionId`
// publish validates; individual tests override it (e.g. null → not-found).
const getVersionByIdMock = jest.fn(
  async (): Promise<{ id: string; versionNumber: number } | null> => ({
    id: "v-pinned",
    versionNumber: 3,
  })
);
jest.mock("@/lib/content/version-service", () => ({
  versionService: {
    getById: (...args: unknown[]) => getVersionByIdMock(...(args as [])),
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
// Records every `.where(...)` condition executed inside the transaction. The
// drizzle-orm mock renders `eq(col, value)` as a plain `[col, value]` array, so a
// flattened scan of these is enough to assert WHICH destination a statement
// targeted — the assertion that `public_web` normalizes onto the one live row
// rather than flipping a row nothing serves (#1726).
let txWhereClauses: unknown[] = [];
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
    // `.where(condition)` records the condition, then stays fluent.
    if (prop === "where")
      return (condition: unknown) => {
        txWhereClauses.push(condition);
        return chainProxy;
      };
    return () => chainProxy;
  },
};
const chainProxy = new Proxy(chain, chainHandler);
const txStub = chainProxy;

// A fluent proxy the mocked `executeQuery` runs its builder callback against, so
// a builder that would touch a real client cannot throw. Query RESULTS come from
// the mock's return value, not from here.
const setRecorder: unknown = new Proxy(
  {},
  {
    get(_t, prop: string | symbol) {
      if (prop === "then") return undefined;
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
  VersionPreconditionFailedError,
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
  liveCheckRows = [{ id: "pub-live" }];
  setLevelInTxCalls = 0;
  adapterPublishCalls = 0;
  adapterUnpublishCalls = 0;
  adapterUnpublishThrows = false;
  publicWebPublishCalls = 0;
  txSetPayloads = [];
  txWhereClauses = [];
  txResults = [];
  jest.clearAllMocks();
});

function definePublishServicePublishSuite1Part1() {
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

  it("does NOT gate the live switch for a caller without publish_public (#1726)", async () => {
    // Making an object live changes no audience — who may read the page is its
    // Level, gated by visibilityService.setLevel. Gating the live switch gated
    // the STATE rather than the exposure, which is what made the old widen
    // prompt both wrong and bypassable.
    txResults = [[{ id: "o1" }], [{ id: "pub1" }]];
    await expect(
      publishService.publish(owner, "o1", { destination: "intranet" })
    ).resolves.toMatchObject({ publicationId: "pub1" });
  });

  it("still gates a CONNECTOR publish for a caller without publish_public (§26.4)", async () => {
    // schoology/google push a copy into an external family-facing system, which
    // IS an exposure regardless of Level — so the gate stays, and fires before
    // the stub's ValidationError only for a caller who could otherwise proceed.
    await expect(
      publishService.publish(owner, "o1", { destination: "google" })
    ).rejects.toThrow();
  });

  it("`public_web` is a legacy alias: it publishes the ONE live intranet row", async () => {
    txResults = [[{ id: "o1" }], [{ id: "pub1" }]];
    const result = await publishService.publish(owner, "o1", {
      destination: "public_web",
    });
    // The intranet reader link, not /p/ — the public address is derived from
    // Level + Live, not from a second publication row.
    expect(result.readerUrl).toBe("/c/s1");
    // The public_web adapter never ran: there is no second row to make live.
    expect(publicWebPublishCalls).toBe(0);
  });

  it("NEVER writes visibility, whatever the caller or the locked level (#1726)", async () => {
    txResults = [
      [{ id: "o1", visibilityLevel: "group" }],
      [{ id: "pub1" }],
    ];
    await publishService.publish(owner, "o1", { destination: "intranet" });
    // The regression this replaces: publishing a Group object ran setLevelInTx,
    // which replaces the grant set — so an author's named people were wiped by
    // the act of publishing.
    expect(setLevelInTxCalls).toBe(0);
  });

  it("rejects a stale public publish under lock before queuing approval", async () => {
    txResults = [
      [
        {
          id: "o1",
          currentVersionId: "v2",
        },
      ],
    ];

    await expect(
      publishService.publish(
        owner,
        "o1",
        { destination: "public_web" },
        { expectedVersionId: "v1" }
      )
    ).rejects.toThrow(VersionPreconditionFailedError);
    expect(publicWebPublishCalls).toBe(0);
    expect(indexObjectMock).not.toHaveBeenCalled();
  });

  }

function definePublishServicePublishSuite1Part2() {it("republishing an ALREADY-public object is an ordinary idempotent publish", async () => {
    // Previously the §26.4 in-transaction gate had to special-case this so a
    // no-op re-save of public content was not treated as a new exposure. With
    // publishing detached from visibility there is no case to special-case.
    txResults = [
      [{ id: "o1", visibilityLevel: "public" }], // FOR UPDATE lock
      [{ id: "pub1" }], // publication upsert RETURNING
    ];
    await expect(
      publishService.publish(owner, "o1", { destination: "intranet" })
    ).resolves.toEqual({
      publicationId: "pub1",
      publishedVersionId: "v1",
      // The destination the service WROTE, not the alias the caller sent (#1726).
      destination: "intranet",
      // #1336 C3: the intranet reader link is DERIVED from the slug (that
      // adapter records a null external_ref by design) and returned so surfaces
      // can show the author where the content went.
      readerUrl: "/c/s1",
    });
    expect(setLevelInTxCalls).toBe(0);
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
      publishService.publish(admin, "o1", { destination: "schoology" })
    ).rejects.toThrow(ValidationError);
    // The exact leak this fix closes: visibility was NEVER widened in a tx...
    expect(setLevelInTxCalls).toBe(0);
    // ...and no adapter side effect ran either.
    expect(adapterPublishCalls).toBe(0);
    expect(publicWebPublishCalls).toBe(0);
  });

  it("fails a schoology/google publish with ValidationError BEFORE the gate for an unauthorized caller (issue #1118 item 6 — doomed requests are not queued)", async () => {
    // schoology & google are not-yet-implemented connector STUBS. Issue #1118 item
    // 6 reorders the cheap adapter-not-implemented check AHEAD of the §26.4 gate:
    // a publish to a stub can NEVER succeed (approving it just re-hits the stub
    // error), so it must fail with a plain ValidationError and NOT be persisted as
    // a doomed approval-queue row. The revealed fact ("destination not yet wired")
    // is static/non-sensitive. (public_web IS implemented, so an unauthorized
    // public_web publish still reaches the gate — see the ApprovalRequiredError
    // test above.) No write, no queued request, no adapter.
    for (const destination of ["schoology", "google"] as const) {
      await expect(
        publishService.publish(owner, "o1", { destination })
      ).rejects.toThrow(ValidationError);
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

  }

function definePublishServicePublishSuite1Part3() {it("the live switch runs the intranet adapter and records no external_ref", async () => {
    // The intranet adapter addresses the object by slug and deliberately returns
    // a null external_ref, so no persist-external-ref UPDATE is issued and the
    // reader link is DERIVED from the same slug the adapter published under.
    txResults = [[{ id: "o1" }], [{ id: "pub1" }]];
    const result = await publishService.publish(admin, "o1", {
      destination: "intranet",
    });
    expect(result).toEqual({
      publicationId: "pub1",
      publishedVersionId: "v1",
      // The destination the service WROTE, not the alias the caller sent (#1726).
      destination: "intranet",
      readerUrl: "/c/s1",
    });
    expect(adapterPublishCalls).toBe(1);
    expect(publicWebPublishCalls).toBe(0);
    expect(
      executeQueryMock.mock.calls.some(
        (call: unknown[]) => call[1] === "publish.persistExternalRef"
      )
    ).toBe(false);
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
    expect(result).toEqual({
      publicationId: "pub1",
      publishedVersionId: "v1",
      // The destination the service WROTE, not the alias the caller sent (#1726).
      destination: "intranet",
      readerUrl: "/c/s1",
    });
    expect(adapterPublishCalls).toBe(1);
    // No visibility provided -> setLevelInTx must NOT run (publish doesn't widen).
    expect(setLevelInTxCalls).toBe(0);
  });

  it("rejects a head changed after preflight under the publish row lock", async () => {
    txResults = [
      [
        {
          id: "o1",
          visibilityLevel: "private",
          currentVersionId: "v2",
        },
      ],
    ];

    await expect(
      publishService.publish(
        owner,
        "o1",
        { destination: "intranet" },
        { expectedVersionId: "v1" }
      )
    ).rejects.toThrow(VersionPreconditionFailedError);
    expect(adapterPublishCalls).toBe(0);
    expect(indexObjectMock).not.toHaveBeenCalled();
  });

  it("publishes a PINNED version (input.versionId), not the head — approval replay (issue #1118 item 1)", async () => {
    // An approval replay pins the raise-time version so the admin publishes the
    // REVIEWED content even though the current head is v1. getById validates the
    // pinned version belongs to the object.
    txResults = [[{ id: "o1" }], [{ id: "pub1" }]];
    const result = await publishService.publish(admin, "o1", {
      destination: "intranet",
      versionId: "v-reviewed",
    });
    expect(result).toEqual({
      publicationId: "pub1",
      publishedVersionId: "v-reviewed",
      destination: "intranet",
      readerUrl: "/c/s1",
    });
    expect(getVersionByIdMock).toHaveBeenCalled();
    // Retrieval must index the PUBLISHED (pinned) version, not the head — else it
    // would surface the unreviewed head text to assistant search (issue #1118 P1).
    expect(indexObjectMock).toHaveBeenCalledWith("o1", "v-reviewed");
  });

  }

function definePublishServicePublishSuite1Part4() {it("throws ValidationError when the pinned versionId does not belong to the object", async () => {
    // getById scopes by object and returns null for a version of another object.
    getVersionByIdMock.mockResolvedValueOnce(null);
    await expect(
      publishService.publish(admin, "o1", {
        destination: "intranet",
        versionId: "not-mine",
      })
    ).rejects.toThrow(ValidationError);
  });

  it("marks the object published without ever calling setLevelInTx", async () => {
    // The status write is now a plain UPDATE on the locked row. Before #1726 it
    // was folded into `setLevelInTx`'s level UPDATE whenever a visibility was
    // supplied — the same call that replaces the object's grant set.
    txResults = [[{ id: "o1" }], [{ id: "pub2" }]];
    await publishService.publish(owner, "o1", { destination: "intranet" });
    expect(setLevelInTxCalls).toBe(0);
    expect(txSetPayloads).toContainEqual(
      expect.objectContaining({ status: "published" })
    );
  });

  it("throws ValidationError when the upsert returns no row", async () => {
    // tx queue: FOR UPDATE lock row (found), then the upsert RETURNING yields [].
    txResults = [[{ id: "o1" }], []];
    await expect(
      publishService.publish(owner, "o1", { destination: "intranet" })
    ).rejects.toThrow(ValidationError);
  });
}

const definePublishServicePublishSuite1 = () => {
  definePublishServicePublishSuite1Part1()
  definePublishServicePublishSuite1Part2()
  definePublishServicePublishSuite1Part3()
  definePublishServicePublishSuite1Part4()
};

describe("publishService.publish", definePublishServicePublishSuite1);

function definePublishServiceUnpublishSuite2Part1() {
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
    // No live publication anywhere → the pre-gate check short-circuits (issue
    // #1118 P2) and returns the no-op WITHOUT opening the transaction.
    liveCheckRows = [];
    const result = await publishService.unpublish(owner, "o1", "intranet");
    expect(result).toEqual({ unpublished: false, destination: "intranet" });
    expect(adapterUnpublishCalls).toBe(0);
  });

  it("an already-offline public_web unpublish by an unauthorized caller is a no-op — NOT gated or queued (issue #1118 P2)", async () => {
    // Nothing live at public_web → there is no exposure to gate. The §26.4 gate
    // must NOT fire and must NOT queue a doomed approval whose replay would only
    // re-run this same no-op. `owner` is a non-admin without publish_public.
    liveCheckRows = [];
    const result = await publishService.unpublish(owner, "o1", "public_web");
    expect(result).toEqual({ unpublished: false, destination: "intranet" });
    // Let any fire-and-forget settle, then assert NO approval request was written.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      executeQueryMock.mock.calls.some(
        (call: unknown[]) => call[1] === "content.publishApprovalRequest"
      )
    ).toBe(false);
    expect(adapterUnpublishCalls).toBe(0);
  });

  it("marks unpublished and runs the adapter teardown AFTER the tx on the happy path", async () => {
    // tx queue: FOR UPDATE lock row, then a live publication row with externalRef.
    txResults = [[{ id: "o1" }], [{ id: "pub1", destination: "intranet", externalRef: null }]];
    const result = await publishService.unpublish(owner, "o1", "intranet");
    expect(result).toEqual({ unpublished: true, destination: "intranet" });
    expect(adapterUnpublishCalls).toBe(1);
  });

  it("prunes the retrieval index BEFORE the adapter teardown (#4 — teardown failure can't strand the index)", async () => {
    // No other destination live → the object goes fully offline, so the index
    // must be pruned. The teardown then throws; the prune must already have run
    // (a retry would idempotently no-op at the `status='live'` filter and never
    // reach a prune placed after the teardown).
    adapterUnpublishThrows = true;
    txResults = [[{ id: "o1" }], [{ id: "pub1", destination: "intranet", externalRef: null }]];
    await expect(
      publishService.unpublish(owner, "o1", "intranet")
    ).rejects.toThrow(/nav hide boom/);
    expect(removeFromIndexMock).toHaveBeenCalledWith("o1");
    expect(adapterUnpublishCalls).toBe(1);
  });

  // §26.4 — taking a CONNECTOR destination offline requires the same authority
  // as putting it up: content:publish_internal alone must not be enough to
  // retract a copy already pushed into an external family-facing system.
  it("throws ApprovalRequiredError unpublishing a CONNECTOR without publish_public, PERSISTS a durable request (issue #1118 item 2), and never touches the tx", async () => {
    await expect(
      publishService.unpublish(owner, "o1", "google")
    ).rejects.toThrow(ApprovalRequiredError);
    // Let the fire-and-forget persist settle, then assert the unpublish request was
    // written to the durable queue — previously this gate raw-threw and queued
    // NOTHING, so a blocked unpublish never appeared in /admin/atrium.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      executeQueryMock.mock.calls.some(
        (call: unknown[]) => call[1] === "content.publishApprovalRequest"
      )
    ).toBe(true);
    expect(adapterUnpublishCalls).toBe(0);
  });

  it("taking the live switch off retires EVERY live-surface row (#1726)", async () => {
    // Normalizing the REQUEST is not enough. An object written before #1726 can
    // be live at `public_web` — alone, or alongside `intranet` — and every reader
    // gate accepts either, so retiring only the normalized row would report
    // success while `/c/{slug}` and `/p/{slug}` kept serving the object from the
    // row nothing touched. Both aliases must be in the target set.
    txResults = [
      [{ id: "o1" }],
      [
        { id: "pub-intranet", destination: "intranet", externalRef: null },
        { id: "pub-legacy", destination: "public_web", externalRef: null },
      ],
    ];
    const result = await publishService.unpublish(owner, "o1", "public_web");
    expect(result).toEqual({ unpublished: true, destination: "intranet" });
    const targeted = txWhereClauses.flat(Infinity);
    expect(targeted).toContain("intranet");
    expect(targeted).toContain("public_web");
    // Both retired rows are flipped in ONE update, addressed by id.
    expect(targeted).toContain("pub-intranet");
    expect(targeted).toContain("pub-legacy");
  });

  it("is a genuine no-op only when NO live-surface row exists", async () => {
    // The pre-gate check reads the same target set; a legacy `public_web`-only
    // object must not be reported as "nothing to do" while it is still serving.
    liveCheckRows = [];
    const result = await publishService.unpublish(owner, "o1", "intranet");
    expect(result).toEqual({ unpublished: false, destination: "intranet" });
    expect(adapterUnpublishCalls).toBe(0);
  });

  }

function definePublishServiceUnpublishSuite2Part2() {it("allows unpublishing a connector when the caller has an explicit publish_public capability", async () => {
    txResults = [[{ id: "o1" }], [{ id: "pub1", destination: "intranet", externalRef: null }]];
    const result = await publishService.unpublish(owner, "o1", "google", {
      hasPublishPublicCapability: true,
    });
    // A connector is NOT folded onto the live row — only the two live-surface
    // aliases are.
    expect(result).toEqual({ unpublished: true, destination: "google" });
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
      [{ id: "pub1", destination: "intranet", externalRef: null }],
      [{ id: "pub-intranet" }],
    ];
    const result = await publishService.unpublish(admin, "o1", "public_web");
    expect(result).toEqual({ unpublished: true, destination: "intranet" });
    const statuses = txSetPayloads.map((p) => p.status);
    // The publication was flipped to unpublished, but the object status was NOT
    // downgraded to draft (intranet remains live).
    expect(statuses).toContain("unpublished");
    expect(statuses).not.toContain("draft");
    // The retrieval index is KEPT while any destination is still live — the
    // content is still published somewhere and must remain retrievable.
    expect(removeFromIndexMock).not.toHaveBeenCalled();
  });

  it("an `okf` bundle does NOT count as still-live: the object drafts and the index prunes", async () => {
    // `okf` is a portable export bundle in S3, not a reader page — `isLive` and
    // `livePublicationConditions` both exclude it, so the Share dialog says Draft
    // and both readers 404 once the live row is retired. An unscoped
    // "any live row?" check counted the okf row, leaving the object
    // `status = 'published'` with its retrieval index intact: invisible in every
    // UI and every reader, still served by assistant retrieval. The tx queue's
    // third result is the still-live check, which must now find NOTHING because
    // the only remaining live row is `okf`.
    txResults = [
      [{ id: "o1" }],
      [{ id: "pub1", destination: "intranet", externalRef: null }],
      [],
    ];
    const result = await publishService.unpublish(admin, "o1", "intranet");
    expect(result).toEqual({ unpublished: true, destination: "intranet" });
    expect(txSetPayloads.map((p) => p.status)).toContain("draft");
    expect(removeFromIndexMock).toHaveBeenCalledWith("o1");
    // The still-live check is scoped to the live-surface destinations, so it can
    // never be satisfied by an `okf` (or connector) row.
    const targeted = txWhereClauses.flat(Infinity);
    expect(targeted).toContain("intranet");
    expect(targeted).toContain("public_web");
    expect(targeted).not.toContain("okf");
  });

  it("prunes the retrieval index only when the last live destination is removed", async () => {
    // tx queue: FOR UPDATE lock, the live row being torn down, then the
    // "any other destination still live?" check returns [] (none remain).
    txResults = [[{ id: "o1" }], [{ id: "pub1", destination: "intranet", externalRef: null }], []];
    const result = await publishService.unpublish(admin, "o1", "public_web");
    expect(result).toEqual({ unpublished: true, destination: "intranet" });
    expect(removeFromIndexMock).toHaveBeenCalledTimes(1);
    expect(removeFromIndexMock).toHaveBeenCalledWith("o1");
  });

  it("does NOT prune the index on the idempotent no-op path (nothing was live)", async () => {
    txResults = [[{ id: "o1" }], []];
    const result = await publishService.unpublish(owner, "o1", "intranet");
    expect(result).toEqual({ unpublished: false, destination: "intranet" });
    expect(removeFromIndexMock).not.toHaveBeenCalled();
  });

  it("a prune failure is best-effort: the unpublish still succeeds", async () => {
    removeFromIndexMock.mockRejectedValueOnce(new Error("index prune boom"));
    txResults = [[{ id: "o1" }], [{ id: "pub1", destination: "intranet", externalRef: null }], []];
    const result = await publishService.unpublish(admin, "o1", "public_web");
    // The unpublish already committed; a failed index prune is logged, not thrown.
    expect(result).toEqual({ unpublished: true, destination: "intranet" });
  });

  it("reverts the object to draft when the unpublished destination was the last live one", async () => {
    // tx queue: FOR UPDATE lock, the live row being torn down, then the
    // "any other destination still live?" check returns [] (none remain).
    txResults = [[{ id: "o1" }], [{ id: "pub1", destination: "intranet", externalRef: null }], []];
    const result = await publishService.unpublish(admin, "o1", "public_web");
    expect(result).toEqual({ unpublished: true, destination: "intranet" });
    const statuses = txSetPayloads.map((p) => p.status);
    expect(statuses).toContain("unpublished");
    expect(statuses).toContain("draft");
  });
}

const definePublishServiceUnpublishSuite2 = () => {
  definePublishServiceUnpublishSuite2Part1()
  definePublishServiceUnpublishSuite2Part2()
};

describe("publishService.unpublish", definePublishServiceUnpublishSuite2);
