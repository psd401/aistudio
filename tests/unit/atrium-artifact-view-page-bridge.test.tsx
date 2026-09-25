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
const loadArtifactCodeSafeMock = jest.fn();
jest.mock("@/lib/content/version-service", () => ({
  versionService: {
    current: (...a: unknown[]) => currentVersionMock(...a),
    loadArtifactCodeSafe: (...a: unknown[]) => loadArtifactCodeSafeMock(...a),
  },
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

type RenderedChild = React.ReactElement & {
  props: Record<string, unknown>;
};

/**
 * The overlay's children. Since #1793 there is more than one: an editor also
 * gets a "Back to editor" link ahead of the sandbox, so callers pick the child
 * they mean rather than assuming a single one.
 */
async function renderOverlayChildren(): Promise<RenderedChild[]> {
  const tree = (await ViewPage({
    params: Promise.resolve({ id: "obj-1" }),
  })) as unknown as { props: { children: React.ReactNode } };
  const children = tree.props.children;
  const list = Array.isArray(children) ? children : [children];
  return list.filter(
    (child): child is RenderedChild =>
      typeof child === "object" && child !== null && "props" in child
  );
}

/** Render the page and hand back the `<ArtifactSandbox>` element it produced. */
async function renderSandbox(): Promise<React.ReactElement> {
  const children = await renderOverlayChildren();
  // The sandbox is the only child carrying the bridge props.
  const sandbox = children.find((child) => "dataBridgeEnabled" in child.props);
  if (!sandbox) throw new Error("no ArtifactSandbox element was rendered");
  return sandbox;
}

beforeEach(() => {
  jest.clearAllMocks();
  getUserRequesterMock.mockResolvedValue({ kind: "user", userId: 7, roles: [] });
  currentVersionMock.mockResolvedValue({ id: "ver-1", versionNumber: 2 });
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
    // belong to exactly one artifact.
    expect(sandbox.key).toBe("obj-1");
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

describe("Atrium full-screen artifact viewer — way back (#1793)", () => {
  /** The "Back to editor" link, if the page rendered one. */
  async function backLink(): Promise<RenderedChild | undefined> {
    const children = await renderOverlayChildren();
    return children.find((child) => "href" in child.props);
  }

  it("offers the owner a link back to the editor", async () => {
    // The route hides every piece of app chrome, so without this an author who
    // followed "Open full screen" had no title, no close and no way back.
    loadByIdOrSlugMock.mockResolvedValue(ARTIFACT);
    canViewMock.mockResolvedValue(true);

    const link = await backLink();
    expect(link).toBeDefined();
    // The SERVER-resolved id, never the route param (which may be a slug).
    expect(link?.props.href).toBe("/atrium/obj-1/edit");
  });

  it("omits it for a viewer who cannot edit", async () => {
    // They would only bounce off the editor's own gate, so the viewport stays
    // chrome-free for them.
    getUserRequesterMock.mockResolvedValue({
      kind: "user",
      userId: 99,
      roles: [],
    });
    loadByIdOrSlugMock.mockResolvedValue(ARTIFACT);
    canViewMock.mockResolvedValue(true);

    expect(await backLink()).toBeUndefined();
    // ...and the artifact itself still renders.
    await expect(renderSandbox()).resolves.toBeDefined();
  });
});
