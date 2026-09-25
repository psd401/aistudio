/**
 * Unit test for the Atrium full-screen artifact viewer's data-bridge wiring
 * (#1725) and its existence-masking gate.
 *
 * `/atrium/[id]/view` is the ONE surface that renders an UNPUBLISHED artifact:
 * `/c/[slug]` redirects a draft here, and the readers require a live
 * publication. Before #1725 it mounted `<ArtifactSandbox>` with no bridge props,
 * so `AtriumData.query()` failed on every draft and an author could not exercise
 * a query-mode dashboard until it was already in front of an audience.
 *
 * What is asserted here is the PAGE-LEVEL wiring the E2E harness cannot reach
 * (it has no `ATRIUM_SANDBOX_ORIGIN`, so a real browser run only ever sees the
 * fail-closed notice — see `tests/e2e/atrium-artifact.guard.spec.ts`):
 *  - a viewable artifact gets `dataBridgeEnabled` + the TRUSTED object id + the
 *    `dataAccess` pin (#1712), keyed on the id so one mount is one artifact;
 *  - the gate still runs FIRST — a missing object, a non-artifact, and a
 *    non-viewable object all 404 without the bridge ever being constructed.
 */

// `notFound()` throws in production to halt rendering; the shared next/navigation
// mock is a no-op jest.fn(), which would let execution fall through past the
// guard and mask a regression. Everything is defined inside the factory because
// the page is imported through hoisted statements that run before any outer
// `const` initializes (TDZ).
jest.mock("next/navigation", () => {
  const sentinel = "__atrium-view-not-found__";
  return {
    __NOT_FOUND_SENTINEL: sentinel,
    notFound: jest.fn(() => {
      throw sentinel;
    }),
  };
});

const getUserRequesterMock = jest.fn();
jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: (...a: unknown[]) => getUserRequesterMock(...a),
}));

const loadByIdOrSlugMock = jest.fn();
jest.mock("@/lib/content/content-service", () => ({
  contentService: { loadByIdOrSlug: (...a: unknown[]) => loadByIdOrSlugMock(...a) },
}));

const canViewMock = jest.fn();
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: { canView: (...a: unknown[]) => canViewMock(...a) },
}));

const currentVersionMock = jest.fn();
const getByIdMock = jest.fn();
const loadArtifactCodeSafeMock = jest.fn();
jest.mock("@/lib/content/version-service", () => ({
  versionService: {
    current: (...a: unknown[]) => currentVersionMock(...a),
    getById: (...a: unknown[]) => getByIdMock(...a),
    loadArtifactCodeSafe: (...a: unknown[]) => loadArtifactCodeSafeMock(...a),
  },
}));

const livePublishedVersionIdMock = jest.fn();
jest.mock("@/lib/content/live-publication", () => ({
  livePublishedVersionId: (...a: unknown[]) => livePublishedVersionIdMock(...a),
}));

jest.mock("@/lib/content/artifact-sandbox-config", () => ({
  getArtifactSandboxRenderUrl: () => "https://sandbox.example.test/render",
}));

// Inert stand-in: this test inspects the element's props, not the sandbox's
// internals (covered by tests/unit/atrium-artifact-data-bridge.test.tsx).
jest.mock("@/components/atrium/ArtifactSandbox", () => ({
  ArtifactSandbox: () => null,
}));

import ViewPage from "@/app/(protected)/atrium/[id]/view/page";
import * as nextNavigation from "next/navigation";

const mockNotFound = nextNavigation.notFound as unknown as jest.Mock;
const NOT_FOUND_SENTINEL = (
  nextNavigation as unknown as { __NOT_FOUND_SENTINEL: string }
).__NOT_FOUND_SENTINEL;

const ARTIFACT = {
  id: "obj-1",
  kind: "artifact" as const,
  ownerUserId: 7,
  collectionId: null,
  visibilityLevel: "private" as const,
  title: "Device repair dashboard",
  dataAccess: "query" as const,
};

/** Render the page and hand back the `<ArtifactSandbox>` element it produced. */
async function renderSandbox(
  searchParams: Record<string, string | string[] | undefined> = {}
): Promise<React.ReactElement> {
  const tree = (await ViewPage({
    params: Promise.resolve({ id: "obj-1" }),
    searchParams: Promise.resolve(searchParams),
  })) as unknown as { props: { children: React.ReactElement } };
  return tree.props.children;
}

beforeEach(() => {
  jest.clearAllMocks();
  // userId 7 === ARTIFACT.ownerUserId, so the default requester is an EDITOR
  // and therefore gets the working head (the pre-#1789 behaviour).
  getUserRequesterMock.mockResolvedValue({ kind: "user", userId: 7, roles: [] });
  currentVersionMock.mockResolvedValue({
    id: "ver-1",
    versionNumber: 2,
    dataAccess: null,
  });
  livePublishedVersionIdMock.mockResolvedValue(null);
  loadArtifactCodeSafeMock.mockResolvedValue("<p>artifact</p>");
});

describe("Atrium full-screen artifact viewer — data bridge (#1725)", () => {
  it("enables the bridge with the trusted object id and the loaded mode for a draft the caller can view", async () => {
    // Deliberately a DRAFT: no publication is consulted anywhere on this route,
    // which is the whole point — publication was never the authorization.
    loadByIdOrSlugMock.mockResolvedValue({ ...ARTIFACT, status: "draft" });
    canViewMock.mockResolvedValue(true);

    const sandbox = await renderSandbox();

    expect(sandbox.props).toEqual(
      expect.objectContaining({
        dataBridgeEnabled: true,
        // The id comes from the SERVER-resolved object, never from the route
        // param (which may be a slug) or anything the artifact can influence.
        contentId: "obj-1",
        dataAccess: "query",
      })
    );
    // #1712: the pin lives in a ref for the mount's lifetime, so a mount must
    // belong to exactly one artifact — and (#1789) one version of it.
    expect(sandbox.key).toBe("obj-1:ver-1");
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("pins the audit to the version THIS render loaded (#1787)", async () => {
    // The page never remounts when the head advances, so without this a
    // still-open old version would be audited under the newer head.
    loadByIdOrSlugMock.mockResolvedValue(ARTIFACT);
    canViewMock.mockResolvedValue(true);

    const sandbox = await renderSandbox();

    expect(sandbox.props).toEqual(expect.objectContaining({ versionId: "ver-1" }));
  });

  it("forwards the artifact's own mode rather than assuming query", async () => {
    loadByIdOrSlugMock.mockResolvedValue({ ...ARTIFACT, dataAccess: "records" });
    canViewMock.mockResolvedValue(true);

    const sandbox = await renderSandbox();

    expect(sandbox.props).toEqual(
      expect.objectContaining({ dataAccess: "records" })
    );
  });

  it("404s (never renders a bridge) when the caller cannot view the artifact", async () => {
    loadByIdOrSlugMock.mockResolvedValue(ARTIFACT);
    canViewMock.mockResolvedValue(false);

    await expect(renderSandbox()).rejects.toBe(NOT_FOUND_SENTINEL);

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(loadArtifactCodeSafeMock).not.toHaveBeenCalled();
  });

  it("404s for a non-artifact object before any bridge decision", async () => {
    loadByIdOrSlugMock.mockResolvedValue({ ...ARTIFACT, kind: "document" });

    await expect(renderSandbox()).rejects.toBe(NOT_FOUND_SENTINEL);

    expect(canViewMock).not.toHaveBeenCalled();
  });

  it("404s for an absent object", async () => {
    loadByIdOrSlugMock.mockResolvedValue(null);

    await expect(renderSandbox()).rejects.toBe(NOT_FOUND_SENTINEL);
  });
});

describe("Atrium full-screen artifact viewer — Live/Draft (#1789)", () => {
  /** A viewer who is neither the owner nor an admin. */
  const READER = { kind: "user" as const, userId: 42, roles: [] };

  it("shows a NON-EDITOR the live published version, not the author's head", async () => {
    // The scenario: a reader on the Live `/c/` page clicks "Full screen". Before
    // #1789 they landed on the author's half-finished draft.
    loadByIdOrSlugMock.mockResolvedValue(ARTIFACT);
    canViewMock.mockResolvedValue(true);
    getUserRequesterMock.mockResolvedValue(READER);
    livePublishedVersionIdMock.mockResolvedValue("ver-published");
    getByIdMock.mockResolvedValue({
      id: "ver-published",
      versionNumber: 1,
      dataAccess: "records",
    });

    const sandbox = await renderSandbox();

    expect(getByIdMock).toHaveBeenCalledWith("obj-1", "ver-published");
    expect(currentVersionMock).not.toHaveBeenCalled();
    expect(sandbox.props).toEqual(
      expect.objectContaining({
        versionId: "ver-published",
        // The mode the PUBLISHED version was published with — the object is in
        // `query` (the author's draft), which must not leak onto this render.
        dataAccess: "records",
      })
    );
  });

  it("ignores a ?version= a NON-EDITOR supplies for a Live object", async () => {
    loadByIdOrSlugMock.mockResolvedValue(ARTIFACT);
    canViewMock.mockResolvedValue(true);
    getUserRequesterMock.mockResolvedValue(READER);
    livePublishedVersionIdMock.mockResolvedValue("ver-published");
    getByIdMock.mockResolvedValue({
      id: "ver-published",
      versionNumber: 1,
      dataAccess: "records",
    });

    const sandbox = await renderSandbox({ version: "ver-draft" });

    expect(getByIdMock).toHaveBeenCalledWith("obj-1", "ver-published");
    expect(sandbox.props).toEqual(
      expect.objectContaining({ versionId: "ver-published" })
    );
  });

  it("still renders the head for a NON-EDITOR when the object is not Live", async () => {
    // The `/c/` dead-link backstop (PR #1699) redirects a viewable-but-
    // unpublished object here. There is no published version to show, so 404ing
    // would break that backstop for exactly the audience it exists for.
    loadByIdOrSlugMock.mockResolvedValue(ARTIFACT);
    canViewMock.mockResolvedValue(true);
    getUserRequesterMock.mockResolvedValue(READER);
    livePublishedVersionIdMock.mockResolvedValue(null);

    const sandbox = await renderSandbox();

    expect(currentVersionMock).toHaveBeenCalledWith("obj-1");
    expect(sandbox.props).toEqual(
      expect.objectContaining({ versionId: "ver-1" })
    );
  });

  it("honours ?version= for an EDITOR when it belongs to this object", async () => {
    loadByIdOrSlugMock.mockResolvedValue(ARTIFACT);
    canViewMock.mockResolvedValue(true);
    getByIdMock.mockResolvedValue({
      id: "ver-published",
      versionNumber: 1,
      dataAccess: "records",
    });

    const sandbox = await renderSandbox({ version: "ver-published" });

    expect(sandbox.props).toEqual(
      expect.objectContaining({
        versionId: "ver-published",
        dataAccess: "records",
      })
    );
  });

  it("falls back to the head when an EDITOR's ?version= belongs to another object", async () => {
    // `versionService.getById` is scoped by object id, so a foreign id simply
    // finds nothing — it can never lend its code or its mode to this artifact.
    loadByIdOrSlugMock.mockResolvedValue(ARTIFACT);
    canViewMock.mockResolvedValue(true);
    getByIdMock.mockResolvedValue(null);

    const sandbox = await renderSandbox({ version: "ver-of-another-object" });

    expect(sandbox.props).toEqual(
      expect.objectContaining({
        versionId: "ver-1",
        // No stamp on the head → the object's own mode, i.e. the pre-#1789
        // behaviour for a version written before migration 184.
        dataAccess: "query",
      })
    );
  });

  it("reads only the first value of a repeated ?version= param", async () => {
    loadByIdOrSlugMock.mockResolvedValue(ARTIFACT);
    canViewMock.mockResolvedValue(true);
    getByIdMock.mockResolvedValue({
      id: "ver-published",
      versionNumber: 1,
      dataAccess: "records",
    });

    await renderSandbox({ version: ["ver-published", "ver-other"] });

    expect(getByIdMock).toHaveBeenCalledWith("obj-1", "ver-published");
  });
});
