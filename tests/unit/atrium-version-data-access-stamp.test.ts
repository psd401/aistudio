/** @jest-environment node */

/**
 * `snapshotInTx` stamps the data-bridge mode onto the version it writes (#1789).
 *
 * This is the write half of version-scoped capability: because every new version
 * records the mode its code was authored for, `/c/` can pin the PUBLISHED
 * version's mode and stop following the author's draft.
 *
 * Two invariants are asserted here:
 *  - artifacts take the object's CURRENT mode, read INSIDE the transaction (a
 *    mode change committing between a caller's load and this insert must not
 *    stamp a stale mode), or the caller's explicit override;
 *  - documents stay NULL — they have no sandbox, and a stray `records` on a
 *    document version is exactly the value a future consumer might trust.
 */

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
  executeTransaction: jest.fn(),
}));
jest.mock("@/lib/db/schema", () => ({
  contentObjects: { id: "id", dataAccess: "data_access" },
  contentVersions: { objectId: "object_id", versionNumber: "version_number" },
  contentEmbedLinks: {},
}));
jest.mock("@/lib/db/drizzle-helpers", () => ({
  pgTimestampAsText: (c: unknown) => c,
  stripJsonQuotes: (v: unknown) => v,
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => a,
  inArray: (...a: unknown[]) => a,
  sql: Object.assign((..._a: unknown[]) => ({}), {}),
}));
jest.mock("@/lib/content/render/markdown-render", () => ({
  renderMarkdownToHtml: () => "<p>unused</p>",
}));
jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: { key: () => "k", putText: jest.fn() },
}));
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {},
}));
jest.mock("@/lib/content/asset-references", () => ({
  pinVersionAssetsInTx: jest.fn(async () => undefined),
}));
jest.mock("@/lib/content/embed-directive", () => ({
  parseEmbeddedArtifactIds: () => [],
}));
jest.mock("@/lib/content/events", () => ({ contentEvents: { emit: jest.fn() } }));

import { snapshotInTx } from "@/lib/content/version-service";
import type { DbTransaction } from "@/lib/db/drizzle-client";
import type { Requester } from "@/lib/content/types";

const req: Requester = {
  kind: "user",
  userId: 1,
  roles: ["staff"],
  isAdmin: false,
};
const noProof = {} as unknown as Parameters<typeof snapshotInTx>[4]["proof"];

interface StubResult {
  tx: DbTransaction;
  /** The values handed to `insert(...).values(...)` for the new version. */
  inserted: () => Record<string, unknown>;
}

// Lock strengths the data_access read requested, in call order.
let lockStrengths: string[] = [];
beforeEach(() => {
  lockStrengths = [];
});

/**
 * A transaction stub covering exactly the calls `snapshotInTx` makes:
 * `maxVersion`'s aggregate select, the in-transaction `data_access` read, the
 * version INSERT, and the head-advancing object UPDATE.
 */
function makeTx(objectDataAccess: string | null): StubResult {
  let inserted: Record<string, unknown> = {};
  // Two selects run in order: maxVersion (no `.limit`) then the data_access read
  // (with `.limit`). They are told apart by which terminal the caller awaits.
  const selectChain = (rows: unknown[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    // The mode read locks the object row (`.for("update")`) so a concurrent
    // mode change cannot land between it and the head advance.
    chain.limit = () => ({
      for: (strength: string) => {
        lockStrengths.push(strength);
        return Promise.resolve(rows);
      },
      then: (resolve: (v: unknown) => unknown) => resolve(rows),
    });
    chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
    return chain;
  };
  let selectCall = 0;
  const tx = {
    select: () => {
      selectCall += 1;
      return selectChain(
        selectCall === 1
          ? [{ max: 4 }]
          : [{ dataAccess: objectDataAccess }]
      );
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted = v;
        return {
          returning: () =>
            Promise.resolve([
              {
                id: "ver-new",
                objectId: v.objectId,
                versionNumber: v.versionNumber,
                authorActor: v.authorActor,
                authorUserId: v.authorUserId,
                authorAgentId: v.authorAgentId,
                bodyFormat: v.bodyFormat,
                bodyLocation: v.bodyLocation,
                bodyInline: v.bodyInline,
                renderLocation: v.renderLocation,
                proofDocRef: null,
                summary: v.summary,
                dataAccess: v.dataAccess,
                createdAt: null,
              },
            ]),
        };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    // Documents also rewrite their embed backlinks; artifacts never do.
    delete: () => ({ where: () => Promise.resolve([]) }),
  } as unknown as DbTransaction;
  return { tx, inserted: () => inserted };
}

describe("snapshotInTx data-access stamping (#1789)", () => {
  it("stamps an artifact version with the object's CURRENT mode", async () => {
    const { tx, inserted } = makeTx("query");

    const result = await snapshotInTx(
      tx,
      req,
      { id: "obj-1", kind: "artifact" },
      { body: "<p>hi</p>", bodyFormat: "html" },
      { proof: noProof }
    );

    expect(inserted().dataAccess).toBe("query");
    expect(result.version.dataAccess).toBe("query");
    // Read under the object row lock, like the head advance it precedes.
    expect(lockStrengths).toEqual(["update"]);
    // The version number still comes from maxVersion + 1.
    expect(inserted().versionNumber).toBe(5);
  });

  it("prefers an explicit mode over the object's (the mode-change fork path)", async () => {
    const { tx, inserted } = makeTx("records");

    await snapshotInTx(
      tx,
      req,
      { id: "obj-1", kind: "artifact" },
      { body: "<p>hi</p>", bodyFormat: "html", dataAccess: "none" },
      { proof: noProof }
    );

    expect(inserted().dataAccess).toBe("none");
  });

  it("fails an out-of-enum object mode closed rather than stamping it", async () => {
    const { tx, inserted } = makeTx("everything");

    await snapshotInTx(
      tx,
      req,
      { id: "obj-1", kind: "artifact" },
      { body: "<p>hi</p>", bodyFormat: "html" },
      { proof: noProof }
    );

    expect(inserted().dataAccess).toBe("none");
  });

  it("leaves a DOCUMENT version unstamped (no sandbox, no mode)", async () => {
    const { tx, inserted } = makeTx("records");

    await snapshotInTx(
      tx,
      req,
      { id: "obj-2", kind: "document" },
      { body: "# hi", bodyFormat: "markdown" },
      { proof: noProof }
    );

    expect(inserted().dataAccess).toBeNull();
  });
});
