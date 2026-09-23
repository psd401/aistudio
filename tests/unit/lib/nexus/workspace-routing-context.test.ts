/**
 * Unit tests for the Nexus workspace ROUTING context (#1786).
 *
 * This is the input that lets the model router know an artifact is open beside
 * the chat before the classifier runs. Two properties matter:
 *   - it reports the resolved id, kind and editability of a viewable object; and
 *   - it NEVER throws — an unknown, unviewable or unresolvable `?workspace=`
 *     must route the turn exactly as it does today rather than break chat.
 */

// NB: use the GLOBAL `jest` (do NOT `import { jest } from "@jest/globals"`) —
// the import form suppresses babel-jest's jest.mock hoisting in this repo.

// content-service transitively pulls the ESM-only remark/rehype render stack,
// which jest's CJS transform cannot load; the service itself is mocked below.
jest.mock("@/lib/content/render/markdown-render", () => ({ renderMarkdownToHtml: jest.fn() }));
jest.mock("@/lib/content/render/html-sanitize", () => ({ sanitizeHtml: jest.fn() }));

const getMock = jest.fn();
const canEditMock = jest.fn();
const requesterMock = jest.fn();

jest.mock("@/lib/content/content-service", () => ({
  contentService: { get: (...a: unknown[]) => getMock(...a) },
}));
jest.mock("@/lib/content/helpers", () => ({
  canEdit: (...a: unknown[]) => canEditMock(...a),
}));
jest.mock("@/lib/content/requester-from-auth", () => ({
  requesterForUserId: (...a: unknown[]) => requesterMock(...a),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { resolveWorkspaceRoutingContext } from "@/lib/nexus/workspace-routing-context";

const ARTIFACT_ID = "441910f0-9e0e-4633-acf1-62415e388db4";

function resolve(workspaceIdOrSlug: string | undefined) {
  return resolveWorkspaceRoutingContext({
    workspaceIdOrSlug,
    userId: 7,
    requestId: "req-1786",
  });
}

describe("resolveWorkspaceRoutingContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requesterMock.mockResolvedValue({ kind: "user", userId: 7 });
    canEditMock.mockReturnValue(true);
    getMock.mockResolvedValue({
      id: ARTIFACT_ID,
      kind: "artifact",
      ownerUserId: 7,
      dataAccess: "query",
      title: "Device repairs",
    });
  });

  it("reports the resolved id, kind and editability", async () => {
    await expect(resolve("device-repairs")).resolves.toEqual({
      objectId: ARTIFACT_ID,
      kind: "artifact",
      editable: true,
    });
    // Resolved through the service, so the caller's slug is never trusted as an id.
    expect(getMock).toHaveBeenCalledWith({ kind: "user", userId: 7 }, "device-repairs");
  });

  it("reports a viewer who cannot edit as not editable", async () => {
    canEditMock.mockReturnValue(false);

    await expect(resolve(ARTIFACT_ID)).resolves.toMatchObject({ editable: false });
  });

  it("returns null when no workspace is open, without touching the service", async () => {
    await expect(resolve(undefined)).resolves.toBeNull();
    expect(requesterMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("returns null when the requester cannot be resolved", async () => {
    requesterMock.mockResolvedValue(null);

    await expect(resolve(ARTIFACT_ID)).resolves.toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("returns null instead of throwing for an unviewable or unknown id", async () => {
    // contentService.get 404-masks a non-viewable object, so a spoofed
    // `?workspace=` lands here and must not become a routing failure.
    getMock.mockRejectedValue(new Error("Content not found"));

    await expect(resolve("someone-elses-dashboard")).resolves.toBeNull();
  });

  it("returns null instead of throwing when the lookup itself fails", async () => {
    requesterMock.mockRejectedValue(new Error("database unavailable"));

    await expect(resolve(ARTIFACT_ID)).resolves.toBeNull();
  });
});
