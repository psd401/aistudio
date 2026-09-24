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
const updateMock = jest.fn();
const loadArtifactCodeMock = jest.fn();
const deleteMock = jest.fn();
const listMock = jest.fn();
const canEditMock = jest.fn();
const canDeleteMock = jest.fn();
const requesterMock = jest.fn();
const applyAgentEditMock = jest.fn();
const readAgentDocMarkdownMock = jest.fn();
const screenMock = jest.fn();
const loadDocStateMock = jest.fn();
const publishMock = jest.fn();
const unpublishMock = jest.fn();
const snapshotBeforePublishMock = jest.fn();

jest.mock("@/lib/content/content-service", () => ({
  contentService: {
    get: (...a: unknown[]) => getMock(...a),
    createVersion: (...a: unknown[]) => createVersionMock(...a),
    update: (...a: unknown[]) => updateMock(...a),
    delete: (...a: unknown[]) => deleteMock(...a),
    list: (...a: unknown[]) => listMock(...a),
  },
}));
jest.mock("@/lib/content/version-service", () => ({
  versionService: {
    loadArtifactCode: (...a: unknown[]) => loadArtifactCodeMock(...a),
  },
}));
jest.mock("@/lib/content/publish-service", () => ({
  publishService: {
    publish: (...a: unknown[]) => publishMock(...a),
    unpublish: (...a: unknown[]) => unpublishMock(...a),
  },
}));
jest.mock("@/lib/content/collab/snapshot-before-publish", () => ({
  snapshotLiveDocumentForPublish: (...a: unknown[]) => snapshotBeforePublishMock(...a),
}));
jest.mock("@/lib/content/helpers", () => ({
  canEdit: (...a: unknown[]) => canEditMock(...a),
  canDelete: (...a: unknown[]) => canDeleteMock(...a),
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
import {
  ApprovalRequiredError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} from "@/lib/content/errors";
import {
  ATRIUM_DATA_AUTHORING_GUIDANCE,
  DATA_ACCESS_DESC,
} from "@/lib/content/atrium-data-contract";

const REQ = { kind: "user", userId: 7, isAdmin: false };
const DOC = { id: "doc-1", kind: "document", title: "My Doc", ownerUserId: 7, version: { bodyFormat: "markdown", bodyInline: "# Hi", versionNumber: 3 } };
const ART = { id: "art-1", kind: "artifact", title: "My Art", ownerUserId: 7, dataAccess: "records", version: { bodyFormat: "jsx", bodyInline: "<div/>", versionNumber: 2 } };
/** A large artifact: source lives in S3, `bodyInline` is null (#1749 barrier B). */
const BIG_ART = { ...ART, version: { bodyFormat: "jsx", bodyInline: null, bodyLocation: "s3://k", versionNumber: 2 } };

// Minimal shim to invoke an AI SDK tool's execute in tests.
type ExecTool = { execute: (args: unknown, opts?: unknown) => Promise<unknown> };
const exec = (t: unknown, args: unknown = {}) => (t as ExecTool).execute(args, {});

beforeEach(() => {
  jest.clearAllMocks();
  // canDelete mirrors canEdit by default (identical for a session user), so tests
  // that toggle canEditMock also drive the delete-tool bind. Override canDeleteMock
  // alone to exercise the deliberate canDelete-vs-canEdit decoupling.
  canDeleteMock.mockImplementation((...a: unknown[]) => canEditMock(...a));
  requesterMock.mockResolvedValue(REQ);
  screenMock.mockResolvedValue({ allowed: true });
  applyAgentEditMock.mockResolvedValue(undefined);
  // Default: the live Yjs read succeeds (the authoritative on-screen text).
  readAgentDocMarkdownMock.mockResolvedValue("# Live doc");
  loadDocStateMock.mockResolvedValue({ markdown: "# Projection", revision: 5 });
  publishMock.mockResolvedValue({ publicationId: "pub-1", publishedVersionId: "ver-1" });
  unpublishMock.mockResolvedValue({ unpublished: true });
  snapshotBeforePublishMock.mockResolvedValue(undefined);
  listMock.mockResolvedValue([]);
  updateMock.mockResolvedValue({ id: "art-1" });
  loadArtifactCodeMock.mockResolvedValue("<div>from s3</div>");
  deleteMock.mockResolvedValue({ id: "doc-1", slug: "my-doc", title: "My Doc", kind: "document", versionsDeleted: 3 });
});

// The find/edit-by-id ITEM 3 tools are bound whenever a workspace is open (they
// re-check permission per call), so every bound tool set now includes them.
const ITEM3 = ["edit_atrium_document", "find_atrium_documents"];

function defineBuildWorkspaceChatToolsSuite1Part1() {
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

  it("binds the read tool + the ITEM 3 find/edit tools when the caller cannot edit the OPEN object", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(false);
    const result = await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" });
    // No edit/publish tool for the OPEN (read-only) object, but the per-call-gated
    // find/edit-by-id tools are still available (the user may edit OTHER docs).
    expect(Object.keys(result!.tools).sort()).toEqual([...ITEM3, "read_workspace_content"].sort());
    expect(result!.systemPromptFragment).toContain("read-only");
  });

  it("binds read + edit + publish/unpublish (+ ITEM 3) for an editable document", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    const result = await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" });
    expect(Object.keys(result!.tools).sort()).toEqual(
      [
        ...ITEM3,
        "delete_workspace_content",
        "edit_workspace_document",
        "publish_workspace_content",
        "read_workspace_content",
        "rename_workspace_content",
        "unpublish_workspace_content",
      ].sort()
    );
  });

  it("binds read + update_workspace_artifact + publish/unpublish (+ ITEM 3) for an editable artifact", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const result = await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" });
    expect(Object.keys(result!.tools).sort()).toEqual(
      [
        ...ITEM3,
        "delete_workspace_content",
        "publish_workspace_content",
        "read_workspace_content",
        "rename_workspace_content",
        "unpublish_workspace_content",
        "update_workspace_artifact",
      ].sort()
    );
  });

  // #1750 — the chat is an artifact-authoring surface, so it must carry the same
  // sandbox CSP rule the MCP content tools carry. Without it the model reaches
  // for a chart library on a CDN, the script is blocked with no error, and the
  // user gets a dashboard with blank charts.
  it("puts the sandbox CSP rule on update_workspace_artifact and flags it in the system prompt", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const result = await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" });
    // No cast: `Tool.description` is declared on every member of the ToolSet
    // union, so reading it directly keeps the compiler checking that the AI SDK
    // still has the field. A `{ description?: string }` cast would keep
    // compiling and silently read undefined if the SDK ever renamed it.
    const description = result!.tools.update_workspace_artifact.description;
    expect(description).toContain("SANDBOX CSP:");
    expect(description).toContain("connect-src 'none'");
    expect(result!.systemPromptFragment).toContain("locked-down sandbox");
  });

  it("does NOT put the artifact CSP rule on a DOCUMENT's system prompt (documents are not sandboxed code)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    const result = await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" });
    expect(result!.systemPromptFragment).not.toContain("locked-down sandbox");
  });

  it("does NOT bind delete_workspace_content when canDelete is false even if canEdit is true (decoupling)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    // Simulate a future world where edit widened (e.g. collaborator grants) but the
    // requester is not the owner/admin — delete must NOT be offered.
    canDeleteMock.mockReturnValue(false);
    const result = await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" });
    expect(Object.keys(result!.tools)).not.toContain("delete_workspace_content");
    // Edit is still bound (canEdit true) — only delete is gated off.
    expect(Object.keys(result!.tools)).toContain("edit_workspace_document");
  });

  it("delete_workspace_content deletes via the service (surface 'ui') and reports success", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.delete_workspace_content)) as Record<string, unknown>;
    expect(deleteMock).toHaveBeenCalledWith(REQ, "doc-1", { surface: "ui" });
    expect(out.ok).toBe(true);
    expect(out.deleted).toBe(true);
    expect(out.title).toBe("My Doc");
  });

  it("delete_workspace_content surfaces the live-publication refusal (409) so the model relays it", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    deleteMock.mockRejectedValue(
      new ConflictError("Cannot delete published content — unpublish from intranet first, then delete.")
    );
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.delete_workspace_content)) as Record<string, unknown>;
    expect(out.blocked).toBe(true);
    expect(out.reason).toBe("published");
    expect(String(out.message)).toContain("unpublish");
  });

  it("delete_workspace_content returns a permission error (not blocked) on a Forbidden", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    deleteMock.mockRejectedValue(new ForbiddenError("Not permitted to delete this content"));
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.delete_workspace_content)) as Record<string, unknown>;
    expect(out.blocked).toBeUndefined();
    expect(String(out.error)).toMatch(/permission|owner|administrator/i);
  });

  }

function defineBuildWorkspaceChatToolsSuite1Part2() {it("edit_workspace_document screens then applies via the agent bridge (append default)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.edit_workspace_document, { markdown: "## New section" });
    expect(screenMock).toHaveBeenCalledWith("## New section", "doc-1", "r");
    expect(applyAgentEditMock).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: "doc-1", markdown: "## New section", mode: "append" })
    );
    // #1749: the id the edit landed on — the change signal is scoped by it.
    expect(out).toEqual({ ok: true, objectId: "doc-1", mode: "append" });
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
    expect(out).toEqual({ ok: true, objectId: "art-1", versionNumber: 3 });
    // No dataAccess argument → the mode is NOT touched.
    expect(updateMock).not.toHaveBeenCalled();
  });

  // --- #1749: setting the data-access mode alongside the code ----------------

  it("update_workspace_artifact saves the version BEFORE flipping dataAccess", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    // Order guard: the two writes are not transactional, so the CODE lands first.
    // A mode failure then leaves the new code under the mode the artifact already
    // had; the reverse order could leave OLD code under a WIDER new mode.
    const order: string[] = [];
    updateMock.mockImplementation(async () => { order.push("update"); return { id: "art-1" }; });
    createVersionMock.mockImplementation(async () => { order.push("createVersion"); return { version: { versionNumber: 4 } }; });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.update_workspace_artifact, {
      code: "<div>live</div>",
      dataAccess: "query",
    });
    expect(updateMock).toHaveBeenCalledWith(REQ, "art-1", { dataAccess: "query" });
    expect(order).toEqual(["createVersion", "update"]);
    expect(out).toEqual({
      ok: true,
      objectId: "art-1",
      versionNumber: 4,
      dataAccess: "query",
    });
  });

  it("update_workspace_artifact rejects an invalid dataAccess and writes NOTHING", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.update_workspace_artifact, {
      code: "<div/>",
      dataAccess: "everything",
    })) as { error: string };
    expect(out.error).toMatch(/invalid data access mode/i);
    expect(updateMock).not.toHaveBeenCalled();
    expect(createVersionMock).not.toHaveBeenCalled();
    // Rejected before any service call at all — not even the screen ran.
    expect(screenMock).not.toHaveBeenCalled();
  });

  it("update_workspace_artifact reports the code-saved/mode-unchanged split instead of a clean success", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    createVersionMock.mockResolvedValue({ version: { versionNumber: 5 } });
    updateMock.mockRejectedValue(new ForbiddenError("no edit access"));
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.update_workspace_artifact, {
      code: "<div/>",
      dataAccess: "query",
    })) as { ok: true; versionNumber: number; dataAccess?: string; warning?: string };
    // The version DID land, so the call is not an error — but the mode did not,
    // and the result must say so rather than reporting an effective mode.
    expect(out.ok).toBe(true);
    expect(out.versionNumber).toBe(5);
    expect(out.dataAccess).toBeUndefined();
    expect(out.warning).toMatch(/mode could NOT be changed to 'query'/);
  });

  it("update_workspace_artifact leaves the mode alone when the version save fails", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    createVersionMock.mockRejectedValue(new ConflictError("version conflict"));
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.update_workspace_artifact, {
      code: "<div/>",
      dataAccess: "query",
    })) as { error: string };
    // Nothing was written: the OLD code must never be left running under a NEW,
    // wider mode it was not authored or screened for.
    expect(updateMock).not.toHaveBeenCalled();
    expect(out.error).toMatch(/could not be saved right now/i);
    expect(out.error).toMatch(/nothing was changed/i);
  });

  /**
   * #1791 finding 4: "switch this to live data" used to require `code`, forcing
   * the model to re-emit the whole 20-60 KB source to change one field — slow,
   * costly, and at real risk of blowing the per-step stream budget.
   */
  it("update_workspace_artifact changes the mode ALONE without creating a version", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    updateMock.mockResolvedValue({ id: "art-1" });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.update_workspace_artifact, { dataAccess: "query" });

    expect(updateMock).toHaveBeenCalledWith(REQ, "art-1", { dataAccess: "query" });
    expect(createVersionMock).not.toHaveBeenCalled();
    // No model-authored bytes are persisted, so there is nothing for the §28.3
    // screen to evaluate.
    expect(screenMock).not.toHaveBeenCalled();
    // `objectId` still drives the panel refetch signal; no versionNumber,
    // because no version was written.
    expect(out).toEqual({ ok: true, objectId: "art-1", dataAccess: "query" });
  });

  it("a mode-only change that fails is an ERROR, not an ok-with-warning", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    updateMock.mockRejectedValue(new ForbiddenError("no edit access"));
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.update_workspace_artifact, { dataAccess: "query" })) as {
      ok?: true;
      error?: string;
    };
    // Unlike the code+mode path there is no successful half to acknowledge —
    // nothing changed at all, so `ok: true` would be a false success.
    expect(out.ok).toBeUndefined();
    expect(out.error).toMatch(/could NOT be changed to 'query'/);
    expect(out.error).toMatch(/nothing was changed/i);
    expect(createVersionMock).not.toHaveBeenCalled();
  });

  it("update_workspace_artifact rejects a call with neither code nor dataAccess", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.update_workspace_artifact, {})) as { error: string };
    expect(out.error).toMatch(/nothing to change/i);
    expect(updateMock).not.toHaveBeenCalled();
    expect(createVersionMock).not.toHaveBeenCalled();
    expect(screenMock).not.toHaveBeenCalled();
  });

  it("a mode-only call still rejects an invalid dataAccess and writes NOTHING", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.update_workspace_artifact, { dataAccess: "everything" })) as {
      error: string;
    };
    expect(out.error).toMatch(/invalid data access mode/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  /**
   * #1791 finding 3: the library titles a starter artifact with the truncated
   * PROMPT, and the chat had no way to fix it — asked for "a proper title" the
   * model could only edit the artifact's own <h1>, which the library, the panel
   * header and the editor never read.
   */
  it("rename_workspace_content renames through the service and echoes the new slug", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    updateMock.mockResolvedValue({
      id: "art-1",
      title: "Device repairs dashboard",
      slug: "device-repairs-dashboard",
    });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.rename_workspace_content, {
      title: "Device repairs dashboard",
    });
    expect(updateMock).toHaveBeenCalledWith(REQ, "art-1", {
      title: "Device repairs dashboard",
    });
    expect(out).toEqual({
      ok: true,
      objectId: "art-1",
      title: "Device repairs dashboard",
      slug: "device-repairs-dashboard",
    });
  });

  it("rename_workspace_content trims the title before it reaches the service", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    updateMock.mockResolvedValue({ id: "art-1", title: "Repairs", slug: "repairs" });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    await exec(tools.rename_workspace_content, { title: "  Repairs  " });
    // contentService.update validates the TRIMMED title but persists what it is
    // given, so an untrimmed value would store padding and slugify from it.
    expect(updateMock).toHaveBeenCalledWith(REQ, "art-1", { title: "Repairs" });
  });

  it("rename_workspace_content refuses an empty title without calling the service", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.rename_workspace_content, { title: "   " })) as {
      error: string;
    };
    expect(out.error).toMatch(/no title provided/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rename_workspace_content relays a validation failure the model can fix", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    updateMock.mockRejectedValue(
      new ValidationError("Title must be 200 characters or fewer")
    );
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.rename_workspace_content, { title: "x".repeat(400) })) as {
      error: string;
    };
    expect(out.error).toMatch(/200 characters or fewer/);
  });

  it("rename_workspace_content does NOT leak a permission failure's detail", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    updateMock.mockRejectedValue(new ForbiddenError("no edit access"));
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.rename_workspace_content, { title: "New title" })) as {
      error: string;
    };
    expect(out.error).toMatch(/could not be renamed right now/i);
  });

  it("is NOT bound for an object the caller cannot edit", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(false);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    expect(tools.rename_workspace_content).toBeUndefined();
  });

  it("nudges the model to set a real title instead of keeping the prompt", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const result = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    expect(result.systemPromptFragment).toContain("rename_workspace_content");
    expect(result.systemPromptFragment).toMatch(
      /request that created it rather than a name/i
    );
    // A read-only object has no rename tool, so it must not be told about one.
    canEditMock.mockReturnValue(false);
    const readOnly = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    expect(readOnly.systemPromptFragment).not.toContain("rename_workspace_content");
  });

  /**
   * #1791 finding 6: the chat tools run under the user's OWN requester, so the
   * version is correctly `authorActor: "human"` — but the MODEL wrote the code,
   * and the history said "human" with nothing to distinguish it.
   */
  it("stamps the authoring surface on a chat-written version", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    createVersionMock.mockResolvedValue({ version: { versionNumber: 6 } });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    await exec(tools.update_workspace_artifact, { code: "<div/>" });

    expect(createVersionMock).toHaveBeenCalledWith(
      REQ,
      "art-1",
      expect.objectContaining({ authorLabel: "nexus-chat" })
    );
  });

  it("tells the model a mode-only change needs no code", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const description = String(
      (tools.update_workspace_artifact as { description?: unknown }).description
    );
    expect(description).toMatch(/dataAccess with NO code/i);
    expect(description).toMatch(/creates no new version/i);
  });

}

/** #1749 contract + screening assertions (split out for max-lines-per-function). */
function defineBuildWorkspaceChatToolsSuite1Part2b() {
  it("the artifact tool description and editHint carry the SHARED AtriumData contract", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const result = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const artifactTool = result.tools.update_workspace_artifact as {
      description?: string;
      inputSchema?: unknown;
    };
    // Guards against the MCP tools and this surface drifting apart again (#1749).
    expect(artifactTool.description).toContain(ATRIUM_DATA_AUTHORING_GUIDANCE);
    // The mode contract rides on the dataAccess INPUT (what the model reads when
    // it decides which mode to pass), not on the tool description.
    expect(JSON.stringify(artifactTool.inputSchema)).toContain(
      JSON.stringify(DATA_ACCESS_DESC).slice(1, -1)
    );
    expect(result.systemPromptFragment).toContain(ATRIUM_DATA_AUTHORING_GUIDANCE);
    expect(result.systemPromptFragment).toContain("window.AtriumData");
  });

  it("the READ tool description carries the mode contract so the model can interpret dataAccess", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const description = (tools.read_workspace_content as { description?: string }).description ?? "";
    expect(description).toContain(DATA_ACCESS_DESC);
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
      byteOffset: 0,
      totalBytes: Buffer.byteLength("# Live edits\n\nfresh text", "utf8"),
    });
  });

  }

function defineBuildWorkspaceChatToolsSuite1Part3() {it("read_workspace_content reports an EMPTY live document as body:'' (not unavailable, not a refusal)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    // A new / title-only document: the live doc hydrates to empty text.
    readAgentDocMarkdownMock.mockResolvedValue("");
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.read_workspace_content, {});
    expect(loadDocStateMock).not.toHaveBeenCalled();
    expect(out).toEqual({ title: "My Doc", kind: "document", bodyFormat: "markdown", body: "", byteOffset: 0, totalBytes: 0 });
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
    expect(out).toEqual({ title: "My Doc", kind: "document", bodyFormat: "markdown", body: "# Projection", byteOffset: 0, totalBytes: 12 });
  });

  it("read_workspace_content falls back to version.bodyInline when live read AND projection are empty", async () => {
    getMock.mockResolvedValue({ ...DOC, version: { bodyFormat: "markdown", bodyInline: "# Snapshot", versionNumber: 3 } });
    canEditMock.mockReturnValue(true);
    readAgentDocMarkdownMock.mockResolvedValue(null);
    loadDocStateMock.mockResolvedValue({ markdown: "", revision: 5 });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.read_workspace_content, {});
    expect(out).toEqual({ title: "My Doc", kind: "document", bodyFormat: "markdown", body: "# Snapshot", byteOffset: 0, totalBytes: 10 });
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

  // #1749 barrier B: an artifact over the 4 KiB inline threshold lives in S3.
  // Reading it is what makes a SECOND turn ("change the default date range")
  // possible; the old contract reported bodyUnavailable and forced a rewrite.
  it("read_workspace_content loads the S3-backed body for a large artifact", async () => {
    getMock.mockResolvedValue(BIG_ART);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.read_workspace_content, {});
    expect(loadArtifactCodeMock).toHaveBeenCalledWith(BIG_ART.version);
    expect(out).toEqual({
      title: "My Art",
      kind: "artifact",
      bodyFormat: "jsx",
      body: "<div>from s3</div>",
      byteOffset: 0,
      totalBytes: Buffer.byteLength("<div>from s3</div>", "utf8"),
      dataAccess: "records",
    });
  });

  it("read_workspace_content flags bodyUnavailable ONLY when the S3 load fails", async () => {
    getMock.mockResolvedValue(BIG_ART);
    canEditMock.mockReturnValue(true);
    loadArtifactCodeMock.mockRejectedValue(new Error("NoSuchKey"));
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.read_workspace_content, {});
    // Must NOT report body "" (which would let the model rewrite from nothing).
    expect(out).toEqual({
      title: "My Art",
      kind: "artifact",
      bodyFormat: "jsx",
      body: null,
      bodyUnavailable: true,
      dataAccess: "records",
    });
  });


  // --- #1749: the model must be able to SEE and SET the data-access mode ------

  it("read_workspace_content returns dataAccess for an artifact", async () => {
    getMock.mockResolvedValue({ ...ART, dataAccess: "query" });
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.read_workspace_content, {})) as { dataAccess?: string };
    expect(out.dataAccess).toBe("query");
  });

  it("read_workspace_content OMITS dataAccess for a document (no sandbox bridge)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.read_workspace_content, {})) as Record<string, unknown>;
    expect(out).not.toHaveProperty("dataAccess");
  });

}

/**
 * #1787 — close the loop: the model must SEE what the preview actually failed
 * with, or it reports success over a dashboard whose every query broke.
 *
 * Its own suite function so `Part3` stays inside the max-lines-per-function
 * budget the repo lints at zero warnings.
 */
function defineBuildWorkspaceChatToolsPreviewDiagnosticsSuite() {
  const PREVIEW_FAILURE = {
    kind: "data" as const,
    code: "query_error" as const,
    message: 'column "school_name" does not exist',
    sql: "SELECT school_name FROM devices",
  };

  it("read_workspace_content surfaces previewDiagnostics for the bound artifact", async () => {
    getMock.mockResolvedValue({ ...ART, dataAccess: "query" });
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({
      workspaceIdOrSlug: "art-1",
      userId: 7,
      requestId: "r",
      previewDiagnostics: { contentId: "art-1", entries: [PREVIEW_FAILURE] },
    }))!;

    const out = (await exec(tools.read_workspace_content, {})) as Record<string, unknown>;

    expect(out.previewDiagnostics).toEqual([PREVIEW_FAILURE]);
  });

  it("read_workspace_content DROPS a buffer that names a different artifact", async () => {
    // The client buffer is one artifact at a time; a stale (or forged) one must
    // never be reported against the object the server actually bound.
    getMock.mockResolvedValue({ ...ART, dataAccess: "query" });
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({
      workspaceIdOrSlug: "art-1",
      userId: 7,
      requestId: "r",
      previewDiagnostics: {
        contentId: "some-other-artifact",
        entries: [PREVIEW_FAILURE],
      },
    }))!;

    const out = (await exec(tools.read_workspace_content, {})) as Record<string, unknown>;

    expect(out).not.toHaveProperty("previewDiagnostics");
  });

  it("read_workspace_content omits previewDiagnostics when nothing failed", async () => {
    getMock.mockResolvedValue({ ...ART, dataAccess: "query" });
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({
      workspaceIdOrSlug: "art-1",
      userId: 7,
      requestId: "r",
      previewDiagnostics: { contentId: "art-1", entries: [] },
    }))!;

    const out = (await exec(tools.read_workspace_content, {})) as Record<string, unknown>;

    expect(out).not.toHaveProperty("previewDiagnostics");
  });

  it("read_workspace_content never reports previewDiagnostics for a document", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({
      workspaceIdOrSlug: "doc-1",
      userId: 7,
      requestId: "r",
      previewDiagnostics: { contentId: "doc-1", entries: [PREVIEW_FAILURE] },
    }))!;

    const out = (await exec(tools.read_workspace_content, {})) as Record<string, unknown>;

    expect(out).not.toHaveProperty("previewDiagnostics");
  });

  it("the READ tool description tells the model to check previewDiagnostics after a write", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;

    const description = (tools.read_workspace_content as { description: string }).description;

    expect(description).toContain("previewDiagnostics");
    expect(description).toMatch(/after update_workspace_artifact/i);
    // The buffer is read once when the request is sent, so it can never verify
    // an edit made this turn — the description must not claim it can.
    expect(description).toMatch(/NEVER reflect a version you write during this turn/);
    expect(description).not.toMatch(/call this tool again after update_workspace_artifact/i);
  });
}

/** ITEM 2: publish / unpublish the OPEN object. */
function defineBuildWorkspaceChatToolsPublishSuite() {
  it("publish_workspace_content SNAPSHOTS the live document into a version BEFORE publishing (Codex P1)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    // Order guard: the snapshot must complete before publishService.publish reads
    // the head, else the stale/empty version is published.
    const order: string[] = [];
    snapshotBeforePublishMock.mockImplementation(async () => { order.push("snapshot"); });
    publishMock.mockImplementation(async () => { order.push("publish"); return { publicationId: "pub-1" }; });
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.publish_workspace_content, {});
    expect(snapshotBeforePublishMock).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: "doc-1", kind: "document", requestId: "r" })
    );
    expect(order).toEqual(["snapshot", "publish"]);
    expect(publishMock).toHaveBeenCalledWith(REQ, "doc-1", { destination: "intranet" });
    expect(out).toEqual({
      ok: true,
      objectId: "doc-1",
      published: true,
      destination: "intranet",
      publicationId: "pub-1",
    });
  });

  it("unpublish_workspace_content does NOT snapshot (nothing to advance when taking a page offline)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    await exec(tools.unpublish_workspace_content, {});
    expect(snapshotBeforePublishMock).not.toHaveBeenCalled();
  });

  it("publish_workspace_content returns an HONEST queued-for-approval status for a public destination needing approval (never a bypass)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    publishMock.mockRejectedValue(new ApprovalRequiredError("needs approval"));
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.publish_workspace_content, { destination: "public_web" })) as Record<string, unknown>;
    expect(publishMock).toHaveBeenCalledWith(REQ, "doc-1", { destination: "public_web" });
    expect(out.queuedForApproval).toBe(true);
    expect(out.ok).toBeUndefined();
    expect(out.published).toBeUndefined();
    expect(String(out.message)).toMatch(/approval/i);
  });

  it("publish_workspace_content rejects an unknown destination without calling publishService", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.publish_workspace_content, { destination: "okf" })) as { error: string };
    expect(publishMock).not.toHaveBeenCalled();
    expect(out.error).toBeDefined();
  });

  }

/** #1749 paged reads (split out for max-lines-per-function). */
function defineBuildWorkspaceChatToolsReadPagingSuite() {
  type ReadPage = {
    body: string;
    byteOffset?: number;
    totalBytes?: number;
    hasMore?: true;
    nextOffset?: number;
  };

  it("read_workspace_content pages a large body instead of truncating it", async () => {
    // 512 KiB of source is 130k+ tokens — more than a 128k context on its own, so
    // returning it in one tool result failed the turn outright.
    const source = "x".repeat(512 * 1024 + 10);
    getMock.mockResolvedValue(BIG_ART);
    canEditMock.mockReturnValue(true);
    loadArtifactCodeMock.mockResolvedValue(source);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;

    const first = (await exec(tools.read_workspace_content, {})) as ReadPage;
    expect(first.hasMore).toBe(true);
    expect(first.byteOffset).toBe(0);
    expect(first.totalBytes).toBe(source.length);
    expect(Buffer.byteLength(first.body, "utf8")).toBe(96 * 1024);
    expect(first.nextOffset).toBe(96 * 1024);

    // Page to the end; the concatenation must reproduce the source EXACTLY.
    let assembled = first.body;
    let next = first.nextOffset;
    let guard = 0;
    while (next !== undefined && guard++ < 20) {
      const page = (await exec(tools.read_workspace_content, { offset: next })) as ReadPage;
      expect(page.byteOffset).toBe(next);
      assembled += page.body;
      next = page.hasMore ? page.nextOffset : undefined;
    }
    expect(assembled).toBe(source);
  });

  it("read_workspace_content reports a small body as a complete single page", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.read_workspace_content, {})) as ReadPage;
    // No hasMore/nextOffset: the model must not think a complete read is partial.
    expect(out.hasMore).toBeUndefined();
    expect(out.nextOffset).toBeUndefined();
    expect(out.byteOffset).toBe(0);
    expect(out.totalBytes).toBe(Buffer.byteLength("<div/>", "utf8"));
  });

  it("read_workspace_content never splits a multi-byte character across pages", async () => {
    // Every page boundary lands inside a 4-byte emoji unless the slicer walks
    // back off the partial sequence: a split would hand the model U+FFFD at both
    // seams and silently corrupt that character on a rewrite.
    const source = "😀".repeat(40 * 1024); // 160 KiB, no character on a 96 KiB edge
    getMock.mockResolvedValue(BIG_ART);
    canEditMock.mockReturnValue(true);
    loadArtifactCodeMock.mockResolvedValue(source);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;

    let assembled = "";
    let next: number | undefined = 0;
    let guard = 0;
    while (next !== undefined && guard++ < 20) {
      const page: ReadPage = (await exec(tools.read_workspace_content, { offset: next })) as ReadPage;
      expect(page.body).not.toContain("�");
      assembled += page.body;
      next = page.hasMore ? page.nextOffset : undefined;
    }
    expect(assembled).toBe(source);
  });

  it("read_workspace_content clamps an out-of-range offset instead of failing", async () => {
    getMock.mockResolvedValue(ART);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "art-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.read_workspace_content, { offset: 10_000_000 })) as ReadPage;
    // Past the end is an empty final page, not an error and not a silent restart
    // at 0 (which would loop the model forever).
    expect(out.body).toBe("");
    expect(out.hasMore).toBeUndefined();
    expect(out.byteOffset).toBe(Buffer.byteLength("<div/>", "utf8"));
  });
}

function defineBuildWorkspaceChatToolsSuite1Part4() {it("unpublish_workspace_content takes the object offline via publishService", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = await exec(tools.unpublish_workspace_content, {});
    expect(unpublishMock).toHaveBeenCalledWith(REQ, "doc-1", "intranet");
    expect(out).toEqual({ ok: true, objectId: "doc-1", unpublished: true, destination: "intranet" });
  });

  // --- ITEM 3: find + edit an EXISTING document by id -----------------------

  it("find_atrium_documents returns ONLY documents the user can edit (canEdit filter, never a bypass)", async () => {
    getMock.mockResolvedValue(DOC);
    canEditMock.mockReturnValue(true);
    listMock.mockResolvedValue([
      { id: "d1", title: "Mine", slug: "mine", ownerUserId: 7 },
      { id: "d2", title: "Theirs", slug: "theirs", ownerUserId: 99 },
    ]);
    // Editable only for the user's own doc (owner 7), not owner 99.
    canEditMock.mockImplementation((_req: unknown, owner: number) => owner === 7);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    const out = (await exec(tools.find_atrium_documents, { query: "m" })) as { documents: Array<{ id: string }> };
    expect(listMock).toHaveBeenCalledWith(REQ, { kind: "document", query: "m" });
    expect(out.documents).toEqual([{ id: "d1", title: "Mine", slug: "mine" }]);
  });

  it("edit_atrium_document edits a DIFFERENT document by id after re-checking canEdit", async () => {
    getMock.mockResolvedValueOnce(DOC); // bind-time workspace object
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    // The target doc resolved per-call.
    getMock.mockResolvedValueOnce({ id: "other-doc", kind: "document", ownerUserId: 7 });
    const out = await exec(tools.edit_atrium_document, { documentId: "other-doc", markdown: "## Added" });
    expect(getMock).toHaveBeenLastCalledWith(REQ, "other-doc");
    expect(screenMock).toHaveBeenCalledWith("## Added", "other-doc", "r");
    expect(applyAgentEditMock).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: "other-doc", markdown: "## Added", mode: "append" })
    );
    expect(out).toEqual({ ok: true, objectId: "other-doc", mode: "append" });
  });

  it("edit_atrium_document DENIES a non-editor (canEdit false) and does NOT apply", async () => {
    getMock.mockResolvedValueOnce(DOC);
    canEditMock.mockReturnValue(true); // editable workspace object → tools bind
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    // Target doc is viewable but NOT editable by this user.
    getMock.mockResolvedValueOnce({ id: "other-doc", kind: "document", ownerUserId: 99 });
    canEditMock.mockImplementation((_req: unknown, owner: number) => owner === 7);
    const out = (await exec(tools.edit_atrium_document, { documentId: "other-doc", markdown: "hi" })) as { error: string };
    expect(applyAgentEditMock).not.toHaveBeenCalled();
    expect(out.error).toMatch(/edit access/i);
  });

  it("edit_atrium_document masks an unviewable target (contentService.get throws → no such doc)", async () => {
    getMock.mockResolvedValueOnce(DOC);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    getMock.mockRejectedValueOnce(new Error("Content not found"));
    const out = (await exec(tools.edit_atrium_document, { documentId: "secret", markdown: "hi" })) as { error: string };
    expect(applyAgentEditMock).not.toHaveBeenCalled();
    expect(out.error).toMatch(/no document with that id or slug/i);
  });

  it("edit_atrium_document refuses to edit an ARTIFACT (documents only)", async () => {
    getMock.mockResolvedValueOnce(DOC);
    canEditMock.mockReturnValue(true);
    const { tools } = (await buildWorkspaceChatTools({ workspaceIdOrSlug: "doc-1", userId: 7, requestId: "r" }))!;
    getMock.mockResolvedValueOnce({ id: "art-9", kind: "artifact", ownerUserId: 7 });
    const out = (await exec(tools.edit_atrium_document, { documentId: "art-9", markdown: "hi" })) as { error: string };
    expect(applyAgentEditMock).not.toHaveBeenCalled();
    expect(out.error).toMatch(/not a document/i);
  });
}

const defineBuildWorkspaceChatToolsSuite1 = () => {
  defineBuildWorkspaceChatToolsSuite1Part1()
  defineBuildWorkspaceChatToolsSuite1Part2()
  defineBuildWorkspaceChatToolsSuite1Part2b()
  defineBuildWorkspaceChatToolsSuite1Part3()
  defineBuildWorkspaceChatToolsPreviewDiagnosticsSuite()
  defineBuildWorkspaceChatToolsPublishSuite()
  defineBuildWorkspaceChatToolsReadPagingSuite()
  defineBuildWorkspaceChatToolsSuite1Part4()
};

describe("buildWorkspaceChatTools", defineBuildWorkspaceChatToolsSuite1);
