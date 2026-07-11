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
const readAgentDocMarkdownMock = jest.fn();
const screenMock = jest.fn();
const loadDocStateMock = jest.fn();

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
  readAgentDocMarkdown: (...a: unknown[]) => readAgentDocMarkdownMock(...a),
}));
jest.mock("@/lib/content/collab/doc-state-store", () => ({
  loadDocState: (...a: unknown[]) => loadDocStateMock(...a),
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
  // Default: the live Yjs read succeeds (the authoritative on-screen text).
  readAgentDocMarkdownMock.mockResolvedValue("# Live doc");
  loadDocStateMock.mockResolvedValue({ markdown: "# Projection", revision: 5 });
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

  it("edit_workspace_document surfaces an unreachable collab listener as a retryable error (not a permission error)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    applyAgentEditMock.mockRejectedValue(new Error("collab websocket closed"));
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.edit_workspace_document, { markdown: "hi" })) as { error: string };
    expect(out.error).toMatch(/temporarily unreachable/i);
    expect(out.error).not.toMatch(/access|permission/i);
  });

  it("edit_workspace_document reports a generic apply failure for a non-transport error", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    applyAgentEditMock.mockRejectedValue(new Error("collab sync apply failed: boom"));
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.edit_workspace_document, { markdown: "hi" })) as { error: string };
    expect(out.error).toBe("The edit could not be applied to the live document.");
  });

  it("edit_workspace_document does NOT misclassify a wrapped apply failure containing 'timeout' as transient", async () => {
    // Exact-match guard (PR #1186 review): the transient classifier must match only
    // the exact transport messages, not any message that happens to contain "timeout".
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    applyAgentEditMock.mockRejectedValue(new Error("collab sync apply failed: inner request timeout"));
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.edit_workspace_document, { markdown: "hi" })) as { error: string };
    expect(out.error).toBe("The edit could not be applied to the live document.");
    expect(out.error).not.toMatch(/temporarily unreachable/i);
  });

  it("update_workspace_artifact failure does NOT claim a screening block or missing edit access", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    createVersionMock.mockRejectedValue(new Error("A content object with this slug already exists"));
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.update_workspace_artifact, { code: "<div/>" })) as { error: string };
    expect(out.error).not.toMatch(/safety screen|edit access|permission/i);
    expect(out.error).toMatch(/could not be saved/i);
  });

  it("update_workspace_artifact SCREENS the code (§28.3) then creates a version", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    createVersionMock.mockResolvedValue({ version: { versionNumber: 3 } });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.update_workspace_artifact, { code: "<div>new</div>", summary: "tweak" });
    // The human requester bypasses createVersion's internal screening, so the
    // tool MUST screen explicitly before saving (PR #1136 review).
    expect(screenMock).toHaveBeenCalledWith("<div>new</div>", "art-1", "r");
    expect(createVersionMock).toHaveBeenCalledWith(
      REQ,
      "art-1",
      expect.objectContaining({ body: "<div>new</div>", bodyFormat: "jsx", summary: "tweak" })
    );
    expect(out).toEqual({ ok: true, versionNumber: 3 });
  });

  it("update_workspace_artifact refuses (and does NOT createVersion) when screening blocks", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    screenMock.mockResolvedValue({ allowed: false, reason: "blocked", message: "nope" });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.update_workspace_artifact, { code: "bad code" });
    expect(createVersionMock).not.toHaveBeenCalled();
    expect(out).toEqual({ error: "nope" });
  });

  it("read_workspace_content reads the LIVE Yjs doc for a document (not the stale projection)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    readAgentDocMarkdownMock.mockResolvedValue("# Live edits\n\nfresh text");
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.read_workspace_content, {});
    expect(readAgentDocMarkdownMock).toHaveBeenCalledWith("doc-1");
    // The live read short-circuits — the stale projection is NOT consulted.
    expect(loadDocStateMock).not.toHaveBeenCalled();
    expect(out).toEqual({
      title: "My Doc",
      kind: "document",
      bodyFormat: "markdown",
      body: "# Live edits\n\nfresh text",
    });
  });

  it("read_workspace_content reports an EMPTY live document as body:'' (not unavailable, not a refusal)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    // A new / title-only document: the live doc hydrates to empty text.
    readAgentDocMarkdownMock.mockResolvedValue("");
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.read_workspace_content, {});
    expect(loadDocStateMock).not.toHaveBeenCalled();
    expect(out).toEqual({ title: "My Doc", kind: "document", bodyFormat: "markdown", body: "" });
  });

  it("read_workspace_content falls back to the projection when the live read is unavailable (null)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    readAgentDocMarkdownMock.mockResolvedValue(null); // collab listener unreachable
    loadDocStateMock.mockResolvedValue({ markdown: "# Projection", revision: 5 });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.read_workspace_content, {});
    expect(readAgentDocMarkdownMock).toHaveBeenCalledWith("doc-1");
    expect(loadDocStateMock).toHaveBeenCalledWith("doc-1");
    expect(out).toEqual({ title: "My Doc", kind: "document", bodyFormat: "markdown", body: "# Projection" });
  });

  it("read_workspace_content falls back to version.bodyInline when live read AND projection are empty", async () => {
    getMock.mockResolvedValue({ ...DOC, version: { bodyFormat: "markdown", bodyInline: "# Snapshot", versionNumber: 3 } });
    canEditMock.mockReturnValue(true);
    readAgentDocMarkdownMock.mockResolvedValue(null);
    loadDocStateMock.mockResolvedValue({ markdown: "", revision: 5 });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.read_workspace_content, {});
    expect(out).toEqual({ title: "My Doc", kind: "document", bodyFormat: "markdown", body: "# Snapshot" });
  });

  it("read_workspace_content flags bodyUnavailable only when live read, projection AND snapshot are all empty", async () => {
    getMock.mockResolvedValue({ ...DOC, version: { bodyFormat: "markdown", bodyInline: null, versionNumber: 3 } });
    canEditMock.mockReturnValue(true);
    readAgentDocMarkdownMock.mockResolvedValue(null);
    loadDocStateMock.mockResolvedValue({ markdown: "", revision: 5 });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.read_workspace_content, {});
    expect(out).toEqual({ title: "My Doc", kind: "document", bodyFormat: "markdown", body: null, bodyUnavailable: true });
  });

  it("read_workspace_content flags bodyUnavailable for a large artifact (bodyInline null)", async () => {
    getMock.mockResolvedValue({ ...ART, version: { bodyFormat: "jsx", bodyInline: null, versionNumber: 2 } });
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.read_workspace_content, {});
    // Must NOT report body "" (which would let the model rewrite from nothing).
    expect(out).toEqual({
      title: "My Art",
      kind: "artifact",
      bodyFormat: "jsx",
      body: null,
      bodyUnavailable: true,
    });
  });
});
