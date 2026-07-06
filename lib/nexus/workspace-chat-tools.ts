/**
 * Nexus workspace chat tools (Atrium §1087 re-prompt path).
 *
 * When a workspace document/artifact is open beside the chat (`?workspace=<id>`),
 * these server-built AI SDK tools let the model READ and EDIT that open object so
 * the user can tweak it by asking in chat — the "re-prompt via adjacent chat"
 * loop the design spec foregrounds (§1065/§1087). They are the missing wiring:
 * PR #1126 shipped the panel as a pure layout sibling with no content tools in
 * the chat surface, so "ask the chat to change the doc" did nothing.
 *
 * Reuse (no new content logic): tools call the SAME §11–§15 services the Atrium
 * editors and the MCP content tools use —
 *   - documents  → `applyAgentEdit` (the agent bridge): a live y-sync write that
 *     lands on the SAME Yjs doc the open editor is connected to, so the change
 *     appears LIVE in the panel with agent (purple-rail) attribution. Markdown is
 *     §28.3-screened first, exactly like the bridge route.
 *   - artifacts  → `contentService.createVersion`: a new version (the version
 *     dropdown in the canvas picks it up). `createVersion` screens the body
 *     internally and enforces canView/canEdit.
 *
 * Security: built SERVER-SIDE from the resolved `workspaceId`, never from the
 * client `enabledTools`, so the client cannot spoke them onto an object it can't
 * edit. Every tool resolves the object through `contentService` (canView 404-mask
 * → canEdit 403) against the SESSION user's requester. A caller who cannot edit
 * gets only the read tool; an unknown/unviewable id yields NO tools (chat is
 * never broken by a bad `?workspace=`).
 */

import { tool, jsonSchema, type Tool, type ToolSet } from "ai";
import { contentService } from "@/lib/content/content-service";
import { canEdit } from "@/lib/content/helpers";
import { requesterForUserId } from "@/lib/content/requester-from-auth";
import { applyAgentEdit } from "@/lib/content/collab/apply-agent-edit";
import { loadDocState } from "@/lib/content/collab/doc-state-store";
import { screenAgentContent } from "@/lib/content/agent-screening";
import { createLogger } from "@/lib/logger";

/** Free-form attribution label stamped on the purple rail for chat-driven edits. */
const NEXUS_CHAT_AGENT_LABEL = "nexus-chat";
/** Bound on the markdown/code a single chat edit may write (mirrors the bridge). */
const MAX_EDIT_BYTES = 512 * 1024;

export interface WorkspaceChatTools {
  /** AI SDK tools to merge into the model's tool set. */
  tools: ToolSet;
  /** A line appended to the system prompt describing the open object + how to edit it. */
  systemPromptFragment: string;
}

interface ReadResult {
  title: string;
  kind: "document" | "artifact";
  bodyFormat: string | null;
  /** Current content, or null when it is unavailable (never conflated with ""). */
  body: string | null;
  /**
   * True when the content exists but could not be inlined for reading (a large
   * artifact whose source lives at `bodyLocation`). The model must then edit
   * conservatively (append/targeted) rather than assume an empty item.
   */
  bodyUnavailable?: boolean;
}

/**
 * Resolve the CURRENT body of the open object for reading (PR #1136 review):
 * - documents keep their live text in the Yjs doc, projected to
 *   `atrium_doc_state.markdown` — NOT in `version.bodyInline` (null for a live
 *   collab doc). Read the projection, falling back to the version snapshot.
 * - artifacts store small source inline (`bodyInline`); a large artifact's source
 *   lives at `bodyLocation` with `bodyInline` null — report `bodyUnavailable`
 *   rather than telling the model the item is empty (which would let a rewrite
 *   clobber it).
 */
async function resolveReadBody(
  obj: Awaited<ReturnType<typeof contentService.get>>
): Promise<{ body: string | null; bodyUnavailable: boolean }> {
  if (obj.kind === "document") {
    // A live collaborative document keeps its text in the Yjs doc, projected to
    // `atrium_doc_state.markdown`. That projection — not `version.bodyInline`
    // (null for a live doc) — is the readable source. It may lag the very latest
    // unsaved edits, but returning it beats claiming the doc is empty. When it is
    // genuinely unavailable (empty projection, no snapshot), signal
    // `bodyUnavailable` so the model appends/edits conservatively rather than
    // rewriting from nothing (PR #1136 review).
    const state = await loadDocState(obj.id);
    const md =
      state?.markdown && state.markdown.trim().length > 0
        ? state.markdown
        : obj.version?.bodyInline ?? null;
    if (md !== null) return { body: md, bodyUnavailable: false };
    return { body: null, bodyUnavailable: true };
  }
  // artifact: small source is inline; a large artifact's source lives at
  // `bodyLocation` (bodyInline null) — report unavailable, never empty.
  const inline = obj.version?.bodyInline ?? null;
  if (inline !== null) return { body: inline, bodyUnavailable: false };
  return { body: null, bodyUnavailable: obj.version != null };
}

/** Build the read tool (always available for an editable, viewable object). */
function buildReadTool(
  idOrSlug: string,
  userId: number,
  log: ReturnType<typeof createLogger>
): Tool {
  return tool({
    description:
      "Read the current content of the document or artifact open in the workspace panel beside this chat. Call this before editing so your changes build on the current content. If it returns bodyUnavailable, the item has content that could not be loaded — prefer appending or targeted edits over a full rewrite.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async (): Promise<ReadResult | { error: string }> => {
      const req = await requesterForUserId(userId);
      if (!req) return { error: "Could not resolve your identity." };
      try {
        const obj = await contentService.get(req, idOrSlug);
        const { body, bodyUnavailable } = await resolveReadBody(obj);
        return {
          title: obj.title,
          kind: obj.kind as "document" | "artifact",
          bodyFormat: obj.version?.bodyFormat ?? null,
          body,
          ...(bodyUnavailable ? { bodyUnavailable: true } : {}),
        };
      } catch (err) {
        log.warn("read_workspace_content failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { error: "The workspace item could not be read." };
      }
    },
  });
}

/** Build the live document-edit tool (documents only). */
function buildDocumentEditTool(
  objectId: string,
  userId: number,
  requestId: string,
  log: ReturnType<typeof createLogger>
): Tool {
  return tool({
    description:
      "Edit the DOCUMENT open in the workspace panel. Your markdown is written into the live document and appears immediately in the panel, attributed to the assistant. Use mode 'append' to add to the end, or 'replace' to rewrite the whole document.",
    inputSchema: jsonSchema<{ markdown: string; mode?: "append" | "replace" }>({
      type: "object",
      properties: {
        markdown: {
          type: "string",
          description: "The markdown to write into the document.",
        },
        mode: {
          type: "string",
          enum: ["append", "replace"],
          description:
            "append (default) adds blocks at the end; replace rewrites the whole document.",
        },
      },
      required: ["markdown"],
      additionalProperties: false,
    }),
    execute: async (args): Promise<{ ok: true; mode: string } | { error: string }> => {
      const markdown = typeof args?.markdown === "string" ? args.markdown : "";
      const mode = args?.mode === "replace" ? "replace" : "append";
      if (!markdown.trim()) return { error: "No markdown provided to write." };
      if (Buffer.byteLength(markdown, "utf8") > MAX_EDIT_BYTES) {
        return { error: "That edit is too large to apply in one step." };
      }
      // §28.3: screen the agent-authored markdown BEFORE writing (same gate as the
      // agent-bridge route). Fail closed — blocked/unscreenable content is refused.
      const verdict = await screenAgentContent(markdown, objectId, requestId);
      if (!verdict.allowed) {
        log.warn("edit_workspace_document blocked by screening", {
          objectId,
          reason: verdict.reason,
        });
        return {
          error:
            verdict.message ??
            "That content was blocked by the safety screen and was not written.",
        };
      }
      try {
        await applyAgentEdit({
          objectId,
          markdown,
          agentId: NEXUS_CHAT_AGENT_LABEL,
          mode,
        });
        return { ok: true, mode };
      } catch (err) {
        log.error("edit_workspace_document apply failed", {
          objectId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { error: "The edit could not be applied to the live document." };
      }
    },
  });
}

/** Build the artifact-version tool (artifacts only). */
function buildArtifactUpdateTool(
  objectId: string,
  bodyFormat: string,
  userId: number,
  requestId: string,
  log: ReturnType<typeof createLogger>
): Tool {
  return tool({
    description:
      "Update the ARTIFACT open in the workspace panel by creating a new version with the given full source code. The new version appears in the artifact's version dropdown. Provide the COMPLETE code (it replaces the current version's code), not a diff.",
    inputSchema: jsonSchema<{ code: string; summary?: string }>({
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The complete new source code for the artifact.",
        },
        summary: {
          type: "string",
          description: "A short summary of what changed (optional).",
        },
      },
      required: ["code"],
      additionalProperties: false,
    }),
    execute: async (args): Promise<{ ok: true; versionNumber: number } | { error: string }> => {
      const code = typeof args?.code === "string" ? args.code : "";
      const summary = typeof args?.summary === "string" ? args.summary : undefined;
      if (!code.trim()) return { error: "No code provided for the new version." };
      if (Buffer.byteLength(code, "utf8") > MAX_EDIT_BYTES) {
        return { error: "That artifact is too large to save in one step." };
      }
      const req = await requesterForUserId(userId);
      if (!req) return { error: "Could not resolve your identity." };
      // §28.3: this tool runs under a `kind: "user"` (human) requester, and
      // contentService.createVersion only screens AGENT/delegated authors — so
      // the model-generated code would be persisted UNSCREENED without this
      // explicit gate (PR #1136 review, gemini/codex P1). Screen the agent-
      // authored code here, mirroring the document edit path. Fail closed.
      const verdict = await screenAgentContent(code, objectId, requestId);
      if (!verdict.allowed) {
        log.warn("update_workspace_artifact blocked by screening", {
          objectId,
          reason: verdict.reason,
        });
        return {
          error:
            verdict.message ??
            "That content was blocked by the safety screen and was not saved.",
        };
      }
      try {
        // createVersion enforces canView/canEdit (screening already done above).
        const result = await contentService.createVersion(req, objectId, {
          body: code,
          bodyFormat: bodyFormat === "jsx" ? "jsx" : "html",
          summary,
        });
        return { ok: true, versionNumber: result.version?.versionNumber ?? 0 };
      } catch (err) {
        log.warn("update_workspace_artifact failed", {
          objectId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          error:
            "The artifact could not be updated (it may be blocked by the safety screen or you may not have edit access).",
        };
      }
    },
  });
}

/**
 * Build the workspace chat tool set for the object identified by `workspaceIdOrSlug`,
 * or `null` when there is no editable/viewable object to bind (chat proceeds with
 * no workspace tools — never an error).
 */
export async function buildWorkspaceChatTools(params: {
  workspaceIdOrSlug: string;
  userId: number;
  requestId: string;
}): Promise<WorkspaceChatTools | null> {
  const { workspaceIdOrSlug, userId, requestId } = params;
  const log = createLogger({ requestId, module: "nexus-workspace-tools" });

  const req = await requesterForUserId(userId);
  if (!req) return null;

  // Resolve + canView-gate (contentService.get 404-masks a non-viewable object).
  let obj: Awaited<ReturnType<typeof contentService.get>>;
  try {
    obj = await contentService.get(req, workspaceIdOrSlug);
  } catch (err) {
    log.info("No viewable workspace object to bind chat tools", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const kind = obj.kind as "document" | "artifact";
  const editable = canEdit(req, obj.ownerUserId);
  const tools: ToolSet = {
    read_workspace_content: buildReadTool(obj.id, userId, log),
  };

  if (editable) {
    if (kind === "document") {
      tools.edit_workspace_document = buildDocumentEditTool(obj.id, userId, requestId, log);
    } else {
      tools.update_workspace_artifact = buildArtifactUpdateTool(
        obj.id,
        obj.version?.bodyFormat ?? "html",
        userId,
        requestId,
        log
      );
    }
  }

  const editHint = editable
    ? kind === "document"
      ? " You can edit it with the edit_workspace_document tool; your edits appear live in the panel."
      : " You can update it with the update_workspace_artifact tool (provide the complete new code)."
    : " It is read-only for this user.";

  // Escape the title via JSON.stringify: a content title is user-controlled and
  // is interpolated into a SYSTEM instruction block, so a raw title with
  // newlines/quotes could inject prompt structure (PR #1136 review, Copilot).
  const safeTitle = JSON.stringify(obj.title);
  const systemPromptFragment =
    `A ${kind} titled ${safeTitle} is open in the workspace panel beside this chat. ` +
    `When the user asks you to change, add to, or fix it, act on THAT ${kind} rather than answering in chat only. ` +
    `Call read_workspace_content first to see its current content.` +
    editHint;

  log.info("Workspace chat tools bound", {
    objectId: obj.id,
    kind,
    editable,
    toolCount: Object.keys(tools).length,
  });

  return { tools, systemPromptFragment };
}
