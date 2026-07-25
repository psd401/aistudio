/**
 * Unit tests for `listPublicationsAction` / `publishService.listLive` (#1336).
 *
 * This read backs the Publish menu's LIVE badges, the VisibilityChip public-link
 * notice, and the artifact Share target. It is deliberately NOT capability-gated
 * (like `listContentAction`, "where is this published" is bounded by the same
 * view permission as reading the object), which makes its existence-masking the
 * only thing standing between it and an object-id probe — so that is what these
 * tests pin.
 */

const canViewMock = jest.fn(async () => true);
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: { canView: (...a: unknown[]) => canViewMock(...(a as [])) },
}));

const loadByIdOrSlugMock = jest.fn(async () => ({
  id: "obj-1",
  ownerUserId: 7,
  visibilityLevel: "private",
}));
jest.mock("@/lib/content/content-service", () => ({
  contentService: {
    loadByIdOrSlug: (...a: unknown[]) => loadByIdOrSlugMock(...(a as [])),
  },
}));

jest.mock("@/actions/db/atrium/requester", () => ({
  getOptionalRequester: jest.fn(async () => ({
    kind: "user",
    userId: 7,
    roles: ["staff"],
    isAdmin: false,
  })),
}));

// Dispatch canned rows by executeQuery label so `loadPublishable` and the
// publications read can be driven independently.
type Row = Record<string, unknown>;
const queryResults = new Map<string, Row[]>();
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async (_cb: unknown, label?: string) =>
    label ? (queryResults.get(label) ?? []) : []
  ),
  executeTransaction: jest.fn(),
}));

// The publish-adapter registry is imported eagerly by `publish-service`, and the
// OKF adapter pulls the ESM-only unified/rehype markdown stack that jest (SWC)
// cannot transform in node_modules. `listLive` touches none of them, so they are
// stubbed — mirroring tests/unit/atrium-publish-service.test.ts.
jest.mock("@/lib/content/publish-adapters/intranet", () => ({
  intranetAdapter: { destination: "intranet" },
}));
jest.mock("@/lib/content/publish-adapters/public-web", () => ({
  publicWebAdapter: { destination: "public_web" },
}));
jest.mock("@/lib/content/publish-adapters/schoology", () => ({
  schoologyAdapter: { destination: "schoology", implemented: false },
}));
jest.mock("@/lib/content/publish-adapters/google", () => ({
  googleAdapter: { destination: "google", implemented: false },
}));
jest.mock("@/lib/content/publish-adapters/okf", () => ({
  okfAdapter: { destination: "okf" },
}));
jest.mock("@/lib/content/version-service", () => ({ versionService: {} }));
jest.mock("@/lib/content/retrieval-service", () => ({ retrievalService: {} }));

import { listPublicationsAction } from "@/actions/db/atrium/list-publications";

const PUBLISHABLE: Row = {
  ownerUserId: 7,
  visibilityLevel: "private",
  currentVersionId: "v1",
  slug: "my-doc",
  title: "My doc",
  collectionId: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  canViewMock.mockResolvedValue(true);
  loadByIdOrSlugMock.mockResolvedValue({
    id: "obj-1",
    ownerUserId: 7,
    visibilityLevel: "private",
  });
  queryResults.clear();
  queryResults.set("publish.loadPublishable", [PUBLISHABLE]);
  queryResults.set("publish.listLive", []);
});

describe("listPublicationsAction existence masking", () => {
  it("fails for an object the caller cannot view (404-masked, never 403)", async () => {
    canViewMock.mockResolvedValue(false);
    const res = await listPublicationsAction("obj-1");
    expect(res.isSuccess).toBe(false);
    // The message must not distinguish "exists but forbidden" from "absent",
    // or a private object id becomes enumerable.
    expect(res.message).not.toMatch(/permission|forbidden|denied/i);
  });

  it("fails identically for an object that does not exist", async () => {
    loadByIdOrSlugMock.mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof loadByIdOrSlugMock>>
    );
    const res = await listPublicationsAction("nope");
    expect(res.isSuccess).toBe(false);
  });
});

describe("listPublicationsAction results", () => {
  it("returns the persisted external_ref as the public reader URL", async () => {
    queryResults.set("publish.listLive", [
      {
        destination: "public_web",
        externalRef: "https://example.test/p/my-doc",
        publishedVersionId: "v1",
        publishedAt: new Date("2026-07-25T00:00:00Z"),
      },
    ]);
    const res = await listPublicationsAction("obj-1");
    expect(res.isSuccess).toBe(true);
    if (!res.isSuccess) return;
    expect(res.data[0]).toMatchObject({
      destination: "public_web",
      readerUrl: "https://example.test/p/my-doc",
    });
  });

  it("DERIVES the intranet reader URL from the slug (its adapter records null)", async () => {
    queryResults.set("publish.listLive", [
      {
        destination: "intranet",
        externalRef: null,
        publishedVersionId: "v1",
        publishedAt: null,
      },
    ]);
    const res = await listPublicationsAction("obj-1");
    expect(res.isSuccess).toBe(true);
    if (!res.isSuccess) return;
    // Without the derivation the Publish menu would show a LIVE intranet
    // destination with no link to hand the user.
    expect(res.data[0].readerUrl).toBe("/c/my-doc");
    expect(res.data[0].publishedAt).toBeNull();
  });

  it("returns an empty list when nothing is live", async () => {
    const res = await listPublicationsAction("obj-1");
    expect(res.isSuccess).toBe(true);
    if (!res.isSuccess) return;
    expect(res.data).toEqual([]);
  });
});
