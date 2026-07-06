/**
 * Unit tests for `publishService.retractAllPublications` (Epic #1059 completion).
 *
 * The archive cascade: archiving must take an object OFFLINE at EVERY destination
 * (both readers gate on a live `content_publications` row, never on `status`), so
 * this flips every live publication to `unpublished` and runs each destination
 * adapter's teardown. It is a takedown — no §26.4 gate — so the test asserts the
 * flip happens and is idempotent, and that one destination's teardown failure
 * does not abort the others (best-effort).
 */

// A controllable transaction stub: `.for("update").limit(1)` yields the lock row;
// the un-terminated `.where(...)` SELECT of live pubs is awaited directly, so the
// proxy is itself awaitable and resolves to the queued `liveRows`. `.set(payload)`
// records the flip payload.
let lockRow: Array<{ id: string }> = [{ id: "obj-1" }];
let liveRows: Array<{ destination: string; externalRef: string | null }> = [];
const setPayloads: Array<Record<string, unknown>> = [];

function makeTx(): unknown {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop: string | symbol) {
      // Awaiting the un-terminated live-pubs SELECT resolves the proxy to liveRows.
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(liveRows);
      }
      if (prop === "limit") return () => lockRow;
      if (prop === "set")
        return (payload: Record<string, unknown>) => {
          setPayloads.push(payload);
          return proxy;
        };
      return () => proxy;
    },
  };
  const proxy: Record<string, unknown> = new Proxy({}, handler);
  return proxy;
}

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => []),
  executeTransaction: jest.fn(
    async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx())
  ),
}));
jest.mock("@/lib/db/schema", () => ({
  contentObjects: { id: "id" },
  contentPublications: {
    id: "id",
    objectId: "objectId",
    destination: "destination",
    externalRef: "externalRef",
    status: "status",
    updatedAt: "updatedAt",
  },
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
}));

const intranetUnpublish = jest.fn(async (_a: unknown) => undefined);
const publicWebUnpublish = jest.fn(async (_a: unknown) => undefined);
jest.mock("@/lib/content/publish-adapters/intranet", () => ({
  intranetAdapter: { destination: "intranet", unpublish: (a: unknown) => intranetUnpublish(a) },
}));
jest.mock("@/lib/content/publish-adapters/public-web", () => ({
  publicWebAdapter: { destination: "public_web", unpublish: (a: unknown) => publicWebUnpublish(a) },
}));
jest.mock("@/lib/content/publish-adapters/schoology", () => ({
  schoologyAdapter: { destination: "schoology" },
}));
jest.mock("@/lib/content/publish-adapters/google", () => ({
  googleAdapter: { destination: "google" },
}));
jest.mock("@/lib/content/publish-adapters/okf", () => ({
  okfAdapter: { destination: "okf" },
}));
jest.mock("@/lib/content/visibility-service", () => ({ visibilityService: {} }));
jest.mock("@/lib/content/retrieval-service", () => ({ retrievalService: {} }));
jest.mock("@/lib/content/events", () => ({ contentEvents: { emit: jest.fn() } }));

import { publishService } from "@/lib/content/publish-service";
import { NotFoundError } from "@/lib/content/errors";

beforeEach(() => {
  lockRow = [{ id: "obj-1" }];
  liveRows = [];
  setPayloads.length = 0;
  intranetUnpublish.mockClear().mockResolvedValue(undefined);
  publicWebUnpublish.mockClear().mockResolvedValue(undefined);
});

describe("publishService.retractAllPublications", () => {
  it("flips every live publication to unpublished and tears down each destination", async () => {
    liveRows = [
      { destination: "intranet", externalRef: null },
      { destination: "public_web", externalRef: "https://p/x" },
    ];
    await publishService.retractAllPublications("obj-1");
    // The bulk flip ran with status: 'unpublished'.
    expect(setPayloads).toEqual([
      expect.objectContaining({ status: "unpublished" }),
    ]);
    // Each destination's teardown ran (nav hide / reader teardown).
    expect(intranetUnpublish).toHaveBeenCalledWith({ objectId: "obj-1", externalRef: null });
    expect(publicWebUnpublish).toHaveBeenCalledWith({
      objectId: "obj-1",
      externalRef: "https://p/x",
    });
  });

  it("is an idempotent no-op when nothing is live", async () => {
    liveRows = [];
    await publishService.retractAllPublications("obj-1");
    expect(setPayloads).toHaveLength(0);
    expect(intranetUnpublish).not.toHaveBeenCalled();
  });

  it("continues tearing down other destinations when one adapter teardown fails", async () => {
    liveRows = [
      { destination: "intranet", externalRef: null },
      { destination: "public_web", externalRef: "https://p/x" },
    ];
    intranetUnpublish.mockRejectedValueOnce(new Error("nav hide boom"));
    // Best-effort: the publication is already flipped, so a teardown failure is
    // logged, never thrown — and must not skip the other destination.
    await expect(
      publishService.retractAllPublications("obj-1")
    ).resolves.toBeUndefined();
    expect(publicWebUnpublish).toHaveBeenCalledTimes(1);
  });

  it("throws NotFoundError when the object row is gone", async () => {
    lockRow = [];
    await expect(
      publishService.retractAllPublications("obj-1")
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
