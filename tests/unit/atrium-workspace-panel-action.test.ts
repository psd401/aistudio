/**
 * Unit tests for loadWorkspacePanelAction (Epic #1059, spec §17) — the one
 * canView-gated payload behind the Nexus workspace panel. Mirrors the standalone
 * edit page's gate: 404 for absent, 404-MASK for non-viewable (never 403), and the
 * kind-specific fields (sandboxSrc only for artifacts).
 */

const loadByIdOrSlugMock = jest.fn();
jest.mock("@/lib/content/content-service", () => ({
  contentService: { loadByIdOrSlug: (...a: unknown[]) => loadByIdOrSlugMock(...a) },
}));

const canViewMock = jest.fn();
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: { canView: (...a: unknown[]) => canViewMock(...a) },
}));

const getUserRequesterMock = jest.fn();
jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: (...a: unknown[]) => getUserRequesterMock(...a),
}));

const sandboxUrlMock = jest.fn();
jest.mock("@/lib/content/artifact-sandbox-config", () => ({
  getArtifactSandboxRenderUrl: () => sandboxUrlMock(),
}));

import { loadWorkspacePanelAction } from "@/actions/db/atrium/workspace-panel";

const OWNER = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };
const OBJ = {
  id: "obj-1",
  slug: "my-doc",
  title: "My Doc",
  kind: "document",
  ownerUserId: 7,
  visibilityLevel: "private",
};

beforeEach(() => {
  getUserRequesterMock.mockReset().mockResolvedValue(OWNER);
  loadByIdOrSlugMock.mockReset().mockResolvedValue(OBJ);
  canViewMock.mockReset().mockResolvedValue(true);
  sandboxUrlMock.mockReset().mockReturnValue("https://sandbox.example/render");
});

describe("loadWorkspacePanelAction", () => {
  it("returns the document payload (no sandboxSrc) with userId + canEdit for the owner", async () => {
    const result = await loadWorkspacePanelAction("my-doc");
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data).toEqual({
      id: "obj-1",
      slug: "my-doc",
      title: "My Doc",
      kind: "document",
      userId: 7,
      canEdit: true,
      sandboxSrc: null,
    });
  });

  it("returns sandboxSrc for an artifact", async () => {
    loadByIdOrSlugMock.mockResolvedValue({ ...OBJ, kind: "artifact" });
    const result = await loadWorkspacePanelAction("obj-1");
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.kind).toBe("artifact");
    expect(result.data.sandboxSrc).toBe("https://sandbox.example/render");
  });

  it("fails for an absent object (404 semantics)", async () => {
    loadByIdOrSlugMock.mockResolvedValue(null);
    const result = await loadWorkspacePanelAction("missing");
    expect(result.isSuccess).toBe(false);
  });

  it("404-MASKS a non-viewable object (indistinguishable from absent)", async () => {
    canViewMock.mockResolvedValue(false);
    const result = await loadWorkspacePanelAction("my-doc");
    expect(result.isSuccess).toBe(false);
    // The mask: same failure shape as the absent case — no 'forbidden' leak.
    expect(result.message).not.toMatch(/forbidden|permission/i);
  });

  it("canEdit is false for a non-owner viewer (UI hint only)", async () => {
    getUserRequesterMock.mockResolvedValue({ ...OWNER, userId: 99 });
    loadByIdOrSlugMock.mockResolvedValue({ ...OBJ, visibilityLevel: "internal" });
    const result = await loadWorkspacePanelAction("my-doc");
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.canEdit).toBe(false);
    expect(result.data.userId).toBe(99);
  });

  it("rejects an over-long idOrSlug before touching the DB", async () => {
    const result = await loadWorkspacePanelAction("x".repeat(201));
    expect(result.isSuccess).toBe(false);
    expect(loadByIdOrSlugMock).not.toHaveBeenCalled();
  });
});
