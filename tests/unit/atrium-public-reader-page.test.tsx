/**
 * Unit test for the Atrium PUBLIC reader page's anonymous 404-masking wiring
 * (#1057, Phase 7).
 *
 * The public reader at `app/(public)/p/[slug]/page.tsx` is the anonymous, world-
 * readable surface. Its security contract is stricter than the internal reader:
 *   - it consults NO session/requester,
 *   - it renders ONLY an object whose `visibility_level === 'public'` AND that has
 *     a LIVE `public_web` publication,
 *   - every other case (absent slug, non-public object, no live public_web
 *     publication, dangling version) resolves to `notFound()` (404) — NEVER 403,
 *     so a probe cannot distinguish "exists but not public" from "absent".
 *
 * The critical assertion is that a NON-PUBLIC object 404s and its body is never
 * loaded — a public URL must never leak internal/group content, even to a viewer
 * who could see it on the internal reader. This test drives the real page function
 * with mocked dependencies and asserts the masking decisions directly (the always-
 * run E2E guard only proves the route is public, not the per-case masking).
 */

// The markdown render pipeline is pure-ESM and not jest-loadable; the reader
// imports it, so it must be mocked.
jest.mock("@/lib/content/render/markdown-render", () => ({
  renderMarkdownToHtml: (md: string) => `<rendered>${md}</rendered>`,
}));

// notFound() THROWS to halt rendering in production. The default shared mock is a
// no-op, which would mask a fall-through regression. Override it to throw a
// sentinel so the test observes the same halt-on-404 control flow. Everything is
// defined INSIDE the factory (hoisted imports run before any outer const), and the
// sentinel is re-exported so assertions can compare against it.
jest.mock("next/navigation", () => {
  const sentinel = "__atrium-public-reader-not-found__";
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

jest.mock("@/lib/content/artifact-sandbox-config", () => ({
  getArtifactSandboxRenderUrl: () => "https://sandbox.example.test/render",
}));

jest.mock("@/components/atrium/ProvenanceFooter", () => ({
  ProvenanceFooter: () => null,
}));
jest.mock("@/components/atrium/ArtifactSandbox", () => ({
  ArtifactSandbox: () => null,
}));

import PublicReaderPage, {
  generateMetadata,
} from "@/app/(public)/p/[slug]/page";
import * as nextNavigation from "next/navigation";

const mockNotFound = nextNavigation.notFound as unknown as jest.Mock;
const NOT_FOUND_SENTINEL = (
  nextNavigation as unknown as { __NOT_FOUND_SENTINEL: string }
).__NOT_FOUND_SENTINEL;

const PUBLIC_OBJ = {
  id: "obj-1",
  kind: "document",
  title: "Public Doc",
  visibilityLevel: "public",
};
const INTERNAL_OBJ = {
  id: "obj-2",
  kind: "document",
  title: "Internal Doc",
  visibilityLevel: "internal",
};
const PUBLICATION_ROW = { publishedVersionId: "ver-1" };

async function render(slug = "some-slug"): Promise<unknown> {
  return PublicReaderPage({ params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  executeQueryMock.mockReset();
  getByIdMock.mockReset();
  getTextMock.mockReset();
  loadArtifactCodeMock.mockReset();
  mockNotFound.mockClear();
});

describe("Atrium public reader page — anonymous 404 masking", () => {
  it("404s an absent slug (no object) — only the object lookup runs", async () => {
    executeQueryMock.mockResolvedValueOnce([]); // objectBySlug -> none

    await expect(render("does-not-exist")).rejects.toBe(NOT_FOUND_SENTINEL);

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    // The publication lookup is never reached for an absent object.
    expect(executeQueryMock).toHaveBeenCalledTimes(1);
    expect(getByIdMock).not.toHaveBeenCalled();
  });

  it("404s a NON-PUBLIC object BEFORE the publication lookup (never leaks internal content)", async () => {
    executeQueryMock.mockResolvedValueOnce([INTERNAL_OBJ]); // objectBySlug -> internal

    await expect(render()).rejects.toBe(NOT_FOUND_SENTINEL);

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    // The strict public gate short-circuits: the publication query is NOT run and
    // the body is NEVER loaded for a non-public object.
    expect(executeQueryMock).toHaveBeenCalledTimes(1);
    expect(getByIdMock).not.toHaveBeenCalled();
    expect(getTextMock).not.toHaveBeenCalled();
  });

  it("404s a public object with no live public_web publication", async () => {
    executeQueryMock.mockResolvedValueOnce([PUBLIC_OBJ]); // objectBySlug -> public
    executeQueryMock.mockResolvedValueOnce([]); // livePublication -> none

    await expect(render()).rejects.toBe(NOT_FOUND_SENTINEL);

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(executeQueryMock).toHaveBeenCalledTimes(2);
    expect(getByIdMock).not.toHaveBeenCalled();
  });

  it("renders the body for a public, live object (document)", async () => {
    executeQueryMock.mockResolvedValueOnce([PUBLIC_OBJ]); // objectBySlug -> public
    executeQueryMock.mockResolvedValueOnce([PUBLICATION_ROW]); // livePublication
    getByIdMock.mockResolvedValue({ objectId: "obj-1", versionNumber: 3 });
    getTextMock.mockResolvedValue("# hello public");

    const result = await render();

    expect(mockNotFound).not.toHaveBeenCalled();
    expect(getByIdMock).toHaveBeenCalledWith("obj-1", "ver-1");
    expect(result).toBeTruthy();
  });

  it("404s when the published version no longer exists (dangling publication)", async () => {
    executeQueryMock.mockResolvedValueOnce([PUBLIC_OBJ]);
    executeQueryMock.mockResolvedValueOnce([PUBLICATION_ROW]);
    getByIdMock.mockResolvedValue(null); // version deleted

    await expect(render()).rejects.toBe(NOT_FOUND_SENTINEL);

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(getTextMock).not.toHaveBeenCalled();
  });
});

describe("Atrium public reader page — metadata does not leak non-public titles", () => {
  it("returns the real title ONLY for a public, live object", async () => {
    executeQueryMock.mockResolvedValueOnce([PUBLIC_OBJ]);
    executeQueryMock.mockResolvedValueOnce([PUBLICATION_ROW]);

    const meta = await generateMetadata({
      params: Promise.resolve({ slug: "some-slug" }),
    });

    expect(meta.title).toBe("Public Doc");
  });

  it("returns a generic title for a non-public object (no title leak via tab/preview)", async () => {
    executeQueryMock.mockResolvedValueOnce([INTERNAL_OBJ]); // fails the public gate

    const meta = await generateMetadata({
      params: Promise.resolve({ slug: "some-slug" }),
    });

    expect(meta.title).toBe("Atrium");
    // The publication lookup is never reached, mirroring the page's short-circuit.
    expect(executeQueryMock).toHaveBeenCalledTimes(1);
  });
});
