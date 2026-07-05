/**
 * Unit test for the Atrium reader page's 404-existence-masking wiring (#1053).
 *
 * The reader at `app/(protected)/c/[slug]/page.tsx` is the IDOR-sensitive surface:
 * its core security guarantee is that an absent slug, an unpublished object, AND a
 * published-but-not-viewable object ALL resolve to `notFound()` (404) — never a 403
 * that would let an out-of-audience or unauthenticated probe distinguish "exists but
 * forbidden" from "absent" and thereby enumerate private document slugs.
 *
 * The `canView` truth table itself is covered by tests/unit/atrium-visibility.test.ts.
 * What was previously UNCOVERED in CI is the PAGE-LEVEL wiring: that the reader
 * actually routes a `canView === false` result into `notFound()` (and never falls
 * through to load/render the body). The always-run E2E guard cannot exercise this —
 * an anonymous probe is redirected at the middleware before reaching the canView
 * logic, and the authenticated functional spec is gated behind PLAYWRIGHT_AUTH_ENABLED
 * (unset in CI). This test closes that gap by driving the real `ReaderPage` function
 * with mocked dependencies and asserting the masking decision directly.
 */

// The markdown render pipeline is pure-ESM and not jest-loadable (see jest.config.js
// note); the reader imports it, so it must be mocked.
jest.mock("@/lib/content/render/markdown-render", () => ({
  renderMarkdownToHtml: (md: string) => `<rendered>${md}</rendered>`,
}));

// `notFound()` in production THROWS to halt rendering. The shared next/navigation
// mock is a no-op jest.fn(), which would let execution fall through past the guard
// and mask a real regression. Override it to throw a sentinel so the test observes
// the same halt-on-404 control flow the real page has.
//
// Everything is defined INSIDE the factory (no outer const): the page is imported
// through hoisted `import`/`jest.mock` statements that run before any outer `const`
// initializes, so referencing an outer const here throws a TDZ "Cannot access before
// initialization". The sentinel is a string literal re-exported from the mock so the
// assertions can compare against it via the imported module.
jest.mock("next/navigation", () => {
  const sentinel = "__atrium-reader-not-found__";
  return {
    __NOT_FOUND_SENTINEL: sentinel,
    notFound: jest.fn(() => {
      throw sentinel;
    }),
  };
});

const executeQueryMock = jest.fn();
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));
jest.mock("@/lib/db/schema", () => ({
  contentObjects: {},
  contentPublications: {},
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
}));

const canViewMock = jest.fn();
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: { canView: (...a: unknown[]) => canViewMock(...a) },
}));

const getByIdMock = jest.fn();
const loadArtifactCodeMock = jest.fn();
jest.mock("@/lib/content/version-service", () => ({
  versionService: {
    getById: (...a: unknown[]) => getByIdMock(...a),
    loadArtifactCode: (...a: unknown[]) => loadArtifactCodeMock(...a),
  },
}));

const getTextMock = jest.fn();
jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: {
    key: (...a: unknown[]) => a.join("/"),
    getText: (...a: unknown[]) => getTextMock(...a),
  },
}));

const getOptionalRequesterMock = jest.fn();
jest.mock("@/actions/db/atrium/requester", () => ({
  getOptionalRequester: (...a: unknown[]) => getOptionalRequesterMock(...a),
}));

jest.mock("@/lib/content/artifact-sandbox-config", () => ({
  getArtifactSandboxRenderUrl: () => "https://sandbox.example.test/render",
}));

// Presentational components — render to inert stand-ins so the page returns a tree
// without pulling real component internals into the unit test. The sidebar mock
// also matters structurally: the real ReaderCollectionSidebar imports the
// collection-tree action, whose `@/lib/content` barrel would drag the whole
// content stack (okf/retrieval/embeddings) into this unit test.
jest.mock("@/components/atrium/ProvenanceFooter", () => ({
  ProvenanceFooter: () => null,
}));
jest.mock("@/components/atrium/ArtifactSandbox", () => ({
  ArtifactSandbox: () => null,
}));
jest.mock("@/components/atrium/ReaderCollectionSidebar", () => ({
  ReaderCollectionSidebar: () => null,
}));

import ReaderPage from "@/app/(protected)/c/[slug]/page";
import * as nextNavigation from "next/navigation";

const mockNotFound = nextNavigation.notFound as unknown as jest.Mock;
const NOT_FOUND_SENTINEL = (
  nextNavigation as unknown as { __NOT_FOUND_SENTINEL: string }
).__NOT_FOUND_SENTINEL;

const OBJ_ROW = {
  id: "obj-1",
  kind: "document",
  ownerUserId: 7,
  visibilityLevel: "group",
  title: "Sensitive Doc",
};
const PUBLICATION_ROW = { publishedVersionId: "ver-1" };

/** Resolve the slug→object and object→publication lookups in order. */
function withLookups(objRow: unknown, publicationRow: unknown): void {
  // loadPublishedObject runs two executeQuery calls: objectBySlug, then livePublication.
  executeQueryMock.mockResolvedValueOnce(objRow ? [objRow] : []);
  executeQueryMock.mockResolvedValueOnce(publicationRow ? [publicationRow] : []);
}

async function render(slug = "some-slug"): Promise<unknown> {
  return ReaderPage({ params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  executeQueryMock.mockReset();
  canViewMock.mockReset();
  getByIdMock.mockReset();
  getTextMock.mockReset();
  loadArtifactCodeMock.mockReset();
  getOptionalRequesterMock.mockReset();
  mockNotFound.mockClear();
  getOptionalRequesterMock.mockResolvedValue({ kind: "user", userId: 100, roles: [] });
});

describe("Atrium reader page — 404 existence masking", () => {
  it("404s a published-but-not-viewable object (the IDOR guarantee) — never reaches the body", async () => {
    withLookups(OBJ_ROW, PUBLICATION_ROW);
    canViewMock.mockResolvedValue(false); // out-of-audience principal

    await expect(render()).rejects.toBe(NOT_FOUND_SENTINEL);

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    // The masking is real only if the body is NEVER loaded for a non-viewable object:
    // a fall-through that loaded/rendered the version would leak existence + content.
    expect(getByIdMock).not.toHaveBeenCalled();
    expect(getTextMock).not.toHaveBeenCalled();
    expect(loadArtifactCodeMock).not.toHaveBeenCalled();
  });

  it("404s an absent slug (no object) — same response as not-viewable, before canView", async () => {
    withLookups(null, null);

    await expect(render("does-not-exist")).rejects.toBe(NOT_FOUND_SENTINEL);

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    // canView is never consulted for an absent object; the 404 is indistinguishable
    // from the not-viewable 404 above — that indistinguishability IS the masking.
    expect(canViewMock).not.toHaveBeenCalled();
  });

  it("404s an object with no live intranet publication", async () => {
    withLookups(OBJ_ROW, null);

    await expect(render()).rejects.toBe(NOT_FOUND_SENTINEL);

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(canViewMock).not.toHaveBeenCalled();
  });

  it("renders the body for a viewable object (canView === true)", async () => {
    withLookups(OBJ_ROW, PUBLICATION_ROW);
    canViewMock.mockResolvedValue(true);
    getByIdMock.mockResolvedValue({
      objectId: "obj-1",
      versionNumber: 3,
    });
    getTextMock.mockResolvedValue("# hello");

    const result = await render();

    expect(mockNotFound).not.toHaveBeenCalled();
    expect(getByIdMock).toHaveBeenCalledWith("obj-1", "ver-1");
    expect(result).toBeTruthy();
  });

  it("404s when the published version no longer exists (dangling publication)", async () => {
    withLookups(OBJ_ROW, PUBLICATION_ROW);
    canViewMock.mockResolvedValue(true);
    getByIdMock.mockResolvedValue(null); // publication points at a deleted version

    await expect(render()).rejects.toBe(NOT_FOUND_SENTINEL);

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(getTextMock).not.toHaveBeenCalled();
  });
});

/**
 * Reader chrome gating (Epic #1059 completion): the page computes the Edit link
 * with the REAL `canEdit` predicate (the same one the authoring page's save
 * controls use) and threads the object's collection into the sidebar slot. The
 * page returns a `<ReaderShell>` element, so both decisions are directly
 * inspectable on its props without rendering the tree.
 */
describe("Atrium reader page — Edit link + collection sidebar gating", () => {
  /** The ReaderShell props the page's returned element carries. */
  interface ShellProps {
    editHref: string | null;
    collectionId: string | null;
  }

  function shellProps(result: unknown): ShellProps {
    return (result as { props: ShellProps }).props;
  }

  function viewableDoc(collectionId: string | null = null): void {
    withLookups({ ...OBJ_ROW, collectionId }, PUBLICATION_ROW);
    canViewMock.mockResolvedValue(true);
    getByIdMock.mockResolvedValue({ objectId: "obj-1", versionNumber: 3 });
    getTextMock.mockResolvedValue("# hello");
  }

  it("renders the Edit link for the OWNER (canEdit predicate: owner passes)", async () => {
    viewableDoc();
    // The default requester (userId 100) is not the owner; make them the owner.
    getOptionalRequesterMock.mockResolvedValue({
      kind: "user",
      userId: OBJ_ROW.ownerUserId,
      roles: [],
      isAdmin: false,
    });

    const result = await render();
    expect(shellProps(result).editHref).toBe("/atrium/obj-1/edit");
  });

  it("renders the Edit link for an ADMIN non-owner", async () => {
    viewableDoc();
    getOptionalRequesterMock.mockResolvedValue({
      kind: "user",
      userId: 999,
      roles: ["administrator"],
      isAdmin: true,
    });

    const result = await render();
    expect(shellProps(result).editHref).toBe("/atrium/obj-1/edit");
  });

  it("renders NO Edit link for a viewer who cannot edit (non-owner, non-admin)", async () => {
    viewableDoc();
    getOptionalRequesterMock.mockResolvedValue({
      kind: "user",
      userId: 100, // in-audience viewer, but not the owner
      roles: ["staff"],
      isAdmin: false,
    });

    const result = await render();
    expect(shellProps(result).editHref).toBeNull();
  });

  it("threads the object's collection into the sidebar slot (and null when uncollected)", async () => {
    viewableDoc("col-1");
    const withCollection = await render();
    expect(shellProps(withCollection).collectionId).toBe("col-1");

    viewableDoc(null);
    const withoutCollection = await render();
    expect(shellProps(withoutCollection).collectionId).toBeNull();
  });
});
