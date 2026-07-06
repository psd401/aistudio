/**
 * Unit tests for the Nexus workspace chat tools (Atrium §1087).
 *
 * Verifies the tool set the chat route binds when a workspace object is open:
 *   - no tools when the id is unviewable / requester unresolved (chat unbroken);
 *   - read-only tool when the caller cannot edit;
 *   - the correct kind-specific edit tool (document → live bridge, artifact →
 *     new version), each gated + screened;
 *   - a document edit is §28.3-screened and refused when blocked.
 */

// NB: use the GLOBAL `jest` (do NOT `import { jest } from "@jest/globals"`) —
// the import form suppresses babel-jest's jest.mock hoisting in this repo, so
// the mocks below would not intercept the transitive content-service import.

// content-service transitively pulls the ESM-only remark/rehype render stack,
// which jest's CJS transform can't load. Stub the render modules (same pattern
// as tests/unit/atrium-mcp-content-tools.test.ts) — the tools mock the service
// itself, so rendering is never reached.
jest.mock("@/lib/content/render/markdown-render", () => ({ renderMarkdownToHtml: jest.fn() }));
jest.mock("@/lib/content/render/html-sanitize", () => ({ sanitizeHtml: jest.fn() }));

const getMock = jest.fn();
const createVersionMock = jest.fn();
const canEditMock = jest.fn();
const requesterMock = jest.fn();
const applyAgentEditMock = jest.fn();
const screenMock = jest.fn();

jest.mock("@/lib/content/content-service", () => ({
  contentService: {
    get: (...a: unknown[]) => getMock(...a),
    createVersion: (...a: unknown[]) => createVersionMock(...a),
  },
}));
jest.mock("@/lib/content/helpers", () => ({
  canEdit: (...a: unknown[]) => canEditMock(...a),
}));
jest.mock("@/lib/content/requester-from-auth", () => ({
  requesterForUserId: (...a: unknown[]) => requesterMock(...a),
}));
jest.mock("@/lib/content/collab/apply-agent-edit", () => ({
  applyAgentEdit: (...a: unknown[]) => applyAgentEditMock(...a),
}));
jest.mock("@/lib/content/agent-screening", () => ({
  screenAgentContent: (...a: unknown[]) => screenMock(...a),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { buildWorkspaceChatTools } from "@/lib/nexus/workspace-chat-tools";

const REQ = { kind: "user", userId: 7, isAdmin: false };
const DOC = { id: "doc-1", kind: "document", title: "My Doc", ownerUserId: 7, version: { bodyFormat: "markdown", bodyInline: "# Hi", versionNumber: 3 } };
const ART = { id: "art-1", kind: "artifact", title: "My Art", ownerUserId: 7, version: { bodyFormat: "jsx", bodyInline: "<div/>", versionNumber: 2 } };

// Minimal shim to invoke an AI SDK tool's execute in tests.
type ExecTool = { execute: (args: unknown, opts?: unknown) => Promise<unknown> };
const exec = (t: unknown, args: unknown = {}) => (t as ExecTool).execute(args, {});

beforeEach(() => {
  jest.clearAllMocks();
  requesterMock.mockResolvedValue(REQ);
  screenMock.mockResolvedValue({ allowed: true });
  applyAgentEditMock.mockResolvedValue(undefined);
});

describe("buildWorkspaceChatTools", () => {
  it("returns null when the requester cannot be resolved", async () => {
    requesterMock.mockResolvedValue(null);
    const result = await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" });
    expect(result).toBeNull();
  });

  it("returns null when the object is not viewable (contentService.get throws)", async () => {
    getMock.mockRejectedValue(new Error("Content not found"));
    const result = await buildWorkspaceChatTools({ workspaceIdOrSlug: "nope", userId: 7, requestId: "r" });
    expect(result).toBeNull();
  });

  it("binds ONLY the read tool when the caller cannot edit", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(false);
    const result = await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" });
    expect(Object.keys(result!.tools).sort()).toEqual(["read_workspace_content"]);
    expect(result!.systemPromptFragment).toContain("read-only");
  });

  it("binds read + edit_workspace_document for an editable document", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    const result = await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" });
    expect(Object.keys(result!.tools).sort()).toEqual(["edit_workspace_document", "read_workspace_content"]);
  });

  it("binds read + update_workspace_artifact for an editable artifact", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const result = await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" });
    expect(Object.keys(result!.tools).sort()).toEqual(["read_workspace_content", "update_workspace_artifact"]);
  });

  it("edit_workspace_document screens then applies via the agent bridge (append default)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.edit_workspace_document, { markdown: "## New section" });
    expect(screenMock).toHaveBeenCalledWith("## New section", "doc-1", "r");
    expect(applyAgentEditMock).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: "doc-1", markdown: "## New section", mode: "append" })
    );
    expect(out).toEqual({ ok: true, mode: "append" });
  });

  it("edit_workspace_document refuses (and does NOT apply) when screening blocks", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    screenMock.mockResolvedValue({ allowed: false, reason: "blocked", message: "nope" });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.edit_workspace_document, { markdown: "bad" });
    expect(applyAgentEditMock).not.toHaveBeenCalled();
    expect(out).toEqual({ error: "nope" });
  });

  it("update_workspace_artifact creates a new version through contentService", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    createVersionMock.mockResolvedValue({ version: { versionNumber: 3 } });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.update_workspace_artifact, { code: "<div>new</div>", summary: "tweak" });
    expect(createVersionMock).toHaveBeenCalledWith(
      REQ,
      "art-1",
      expect.objectContaining({ body: "<div>new</div>", bodyFormat: "jsx", summary: "tweak" })
    );
    expect(out).toEqual({ ok: true, versionNumber: 3 });
  });

  it("read_workspace_content returns the current title/kind/body", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.read_workspace_content, {});
    expect(out).toEqual({ title: "My Doc", kind: "document", bodyFormat: "markdown", body: "# Hi" });
  });
});
