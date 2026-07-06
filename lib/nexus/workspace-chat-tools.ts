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
  body: string | null;
}

/** Build the read tool (always available for an editable, viewable object). */
function buildReadTool(
  idOrSlug: string,
  userId: number,
  log: ReturnType<typeof createLogger>
): Tool {
  return tool({
    description:
      "Read the current content of the document or artifact open in the workspace panel beside this chat. Call this before editing so your changes build on the current content.",
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
        return {
          title: obj.title,
          kind: obj.kind as "document" | "artifact",
          bodyFormat: obj.version?.bodyFormat ?? null,
          body: obj.version?.bodyInline ?? "",
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
      try {
        // createVersion enforces canView/canEdit and §28.3-screens the body.
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
        log
      );
    }
  }

  const editHint = editable
    ? kind === "document"
      ? " You can edit it with the edit_workspace_document tool; your edits appear live in the panel."
      : " You can update it with the update_workspace_artifact tool (provide the complete new code)."
    : " It is read-only for this user.";

  const systemPromptFragment =
    `A ${kind} titled "${obj.title}" is open in the workspace panel beside this chat. ` +
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
