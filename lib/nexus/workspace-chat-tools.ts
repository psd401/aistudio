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
import { canDelete, canEdit } from "@/lib/content/helpers";
import { requesterForUserId } from "@/lib/content/requester-from-auth";
import { applyAgentEdit, readAgentDocMarkdown } from "@/lib/content/collab/apply-agent-edit";
import { snapshotLiveDocumentForPublish } from "@/lib/content/collab/snapshot-before-publish";
import { loadDocState } from "@/lib/content/collab/doc-state-store";
import { screenAgentContent } from "@/lib/content/agent-screening";
import { publishService } from "@/lib/content/publish-service";
import { assertEditorDestination } from "@/lib/content/validators";
import {
  ApprovalRequiredError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/content/errors";
import { createLogger } from "@/lib/logger";

/** Free-form attribution label stamped on the purple rail for chat-driven edits. */
const NEXUS_CHAT_AGENT_LABEL = "nexus-chat";
/** Bound on the markdown/code a single chat edit may write (mirrors the bridge). */
const MAX_EDIT_BYTES = 512 * 1024;

/**
 * The exact messages `runLoopbackEdit` rejects with when the live collab listener
 * is unreachable / the sync round-trip times out or the socket closes (see
 * apply-agent-edit.ts). Matched EXACTLY (not by substring) so a genuine apply
 * failure — surfaced as the wrapper `collab sync apply failed: <inner>` — is never
 * misclassified as transient just because `<inner>` happens to contain the word
 * "timeout" (PR #1186 review).
 */
const COLLAB_TRANSPORT_ERRORS = new Set([
  "collab websocket error",
  "collab websocket closed",
  "collab sync timeout",
]);

/**
 * True when an agent-bridge failure is a transient TRANSPORT problem (unreachable
 * listener / timed-out sync / closed socket) rather than a genuine content-apply
 * failure. Used to give the model an accurate, retryable message instead of a
 * generic "could not apply".
 */
function isCollabTransportError(message: string): boolean {
  return COLLAB_TRANSPORT_ERRORS.has(message);
}

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
 * Resolve the CURRENT body of the open object for reading (§1087):
 * - documents keep their live text in the Yjs CRDT, which is the ONLY
 *   authoritative source of what is on screen. The `atrium_doc_state.markdown`
 *   projection is set on seed and NEVER re-derived from later edits, so it goes
 *   stale the moment anyone types (and is empty for a title-only/new doc). Read
 *   the LIVE Yjs doc first; only if the live listener is unreachable fall back to
 *   the (possibly stale) projection, then the version snapshot. An empty live
 *   document is a real state (`body: ""`, NOT unavailable) so the model writes an
 *   intro rather than narrating a permission error.
 * - artifacts store small source inline (`bodyInline`); a large artifact's source
 *   lives at `bodyLocation` with `bodyInline` null — report `bodyUnavailable`
 *   rather than telling the model the item is empty (which would let a rewrite
 *   clobber it).
 */
async function resolveReadBody(
  obj: Awaited<ReturnType<typeof contentService.get>>
): Promise<{ body: string | null; bodyUnavailable: boolean }> {
  if (obj.kind === "document") {
    // 1. Live read from the Yjs doc — the current on-screen text. `""` is a
    //    genuinely empty (new / title-only) document, NOT unavailable: reporting
    //    body "" lets the model write an intro. `null` means the live read failed
    //    (collab listener unreachable / timeout) — fall through to the snapshots.
    const live = await readAgentDocMarkdown(obj.id);
    if (live !== null) return { body: live, bodyUnavailable: false };

    // 2. Live read unavailable. Fall back to the persisted markdown projection
    //    (may lag the latest edits), then the version snapshot. Only when neither
    //    exists is the body genuinely unavailable — signal it so the model edits
    //    conservatively rather than rewriting from nothing.
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

/**
 * Screen (§28.3) the agent-authored markdown and, if allowed, write it into the
 * live document via the agent bridge. Shared by the workspace-bound edit tool AND
 * the edit-by-id tool (ITEM 3) so both flow through the identical guardrails + PII
 * screen and the same apply/transport-error handling — no divergence. The CALLER
 * is responsible for confirming edit rights on `objectId` before calling this
 * (the bound tool via bind-time canEdit; the by-id tool via a per-call canEdit).
 */
async function screenAndApplyDocEdit(
  objectId: string,
  markdown: string,
  mode: "append" | "replace",
  requestId: string,
  log: ReturnType<typeof createLogger>
): Promise<{ ok: true; mode: string } | { error: string }> {
  if (!markdown.trim()) return { error: "No markdown provided to write." };
  if (Buffer.byteLength(markdown, "utf8") > MAX_EDIT_BYTES) {
    return { error: "That edit is too large to apply in one step." };
  }
  // §28.3: screen the agent-authored markdown BEFORE writing (same gate as the
  // agent-bridge route). Only a positive guardrails detection refuses the write;
  // a degraded/unavailable evaluation fails OPEN in the core.
  const verdict = await screenAgentContent(markdown, objectId, requestId);
  if (!verdict.allowed) {
    log.warn("workspace doc edit blocked by screening", { objectId, reason: verdict.reason });
    return {
      error:
        verdict.message ??
        "That content was blocked by the safety screen and was not written.",
    };
  }
  try {
    await applyAgentEdit({ objectId, markdown, agentId: NEXUS_CHAT_AGENT_LABEL, mode });
    return { ok: true, mode };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("workspace doc edit apply failed", { objectId, error: message });
    // Distinguish an unreachable live-collab listener (transient, retryable) from a
    // genuine apply failure. Neither is a permission problem — edit access was
    // confirmed before this call — so do not imply one.
    return {
      error: isCollabTransportError(message)
        ? "The live document service is temporarily unreachable, so the edit was not applied. Please try again in a moment."
        : "The edit could not be applied to the live document.",
    };
  }
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
      // Edit rights were confirmed at bind time (this tool is only bound for an
      // editable document); the shared helper screens + applies.
      return screenAndApplyDocEdit(objectId, markdown, mode, requestId, log);
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
      // authored code here, mirroring the document edit path. Only a positive
      // guardrails detection refuses; a degraded evaluation fails OPEN in the core.
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
        // The content was already §28.3-screened above and edit access was
        // confirmed before this tool was bound, so this catch is a save failure
        // (a concurrent-version conflict or storage error) — NOT a screening
        // block or a permission problem. Do not claim either (PR #1136 review).
        return {
          error:
            "The new artifact version could not be saved right now (another change may have been saved at the same time). Please try again.",
        };
      }
    },
  });
}

/**
 * Run a `publish` / `unpublish` op on `objectId` through the SAME `publishService`
 * gate humans use — canView (404-mask), canEdit, and the §26.4 public-destination
 * approval gate. `req` is the delegated SESSION user, so the acting principal's
 * permissions decide (matching the agent-bridge route). A public destination the
 * user may not publish directly returns `queuedForApproval` — an HONEST pending
 * status, never a bypass. `intranet` (internal reader) is the default destination.
 */
interface WorkspacePublishArgs {
  op: "publish" | "unpublish";
  objectId: string;
  kind: "document" | "artifact";
  userId: number;
  requestId: string;
  destinationRaw: string | undefined;
  log: ReturnType<typeof createLogger>;
}

async function runWorkspacePublishOp(args: WorkspacePublishArgs): Promise<Record<string, unknown>> {
  const { op, objectId, kind, userId, requestId, destinationRaw, log } = args;
  const req = await requesterForUserId(userId);
  if (!req) return { error: "Could not resolve your identity." };
  let destination: ReturnType<typeof assertEditorDestination>;
  try {
    destination = assertEditorDestination(destinationRaw ?? "intranet", op);
  } catch (err) {
    return { error: err instanceof ValidationError ? err.message : "Unknown publish destination." };
  }
  try {
    if (op === "publish") {
      // Advance the version head to the live doc content first: chat edits land only
      // on the live Yjs/atrium_doc_state path, so publishing the persisted head
      // without this would ship the stale/empty version (Codex review P1).
      await snapshotLiveDocumentForPublish({ req, objectId, kind, requestId });
      const result = await publishService.publish(req, objectId, { destination });
      return { ok: true, published: true, destination, publicationId: result.publicationId };
    }
    const result = await publishService.unpublish(req, objectId, destination);
    return { ok: true, unpublished: result.unpublished, destination };
  } catch (err) {
    // §26.4: a public destination this user may not publish/unpublish directly is a
    // pending-approval outcome, not a failure — report it honestly so the model tells
    // the user it is queued for review, never that it is live.
    if (err instanceof ApprovalRequiredError) {
      return {
        queuedForApproval: true,
        destination,
        message:
          "This destination requires administrator approval — the request was submitted for review. Tell the user it is pending approval, not live.",
      };
    }
    log.warn(`workspace ${op} failed`, {
      objectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { error: `The ${op} could not be completed right now.` };
  }
}

/** Build the publish/unpublish tool for the WORKSPACE-bound object (ITEM 2). */
function buildPublishTool(args: {
  op: "publish" | "unpublish";
  objectId: string;
  kind: "document" | "artifact";
  userId: number;
  requestId: string;
  log: ReturnType<typeof createLogger>;
}): Tool {
  const { op, objectId, kind, userId, requestId, log } = args;
  const verb = op === "publish" ? "Publish" : "Unpublish";
  return tool({
    description:
      `${verb} the document or artifact open in the workspace panel. ` +
      `destination 'intranet' (default) is the internal reader everyone in the district can reach. ` +
      `destination 'public_web' is the public site and REQUIRES administrator approval — if this user is not permitted, ` +
      `the tool returns queuedForApproval:true and you MUST tell the user it is pending approval, not that it is live.`,
    inputSchema: jsonSchema<{ destination?: "intranet" | "public_web" }>({
      type: "object",
      properties: {
        destination: {
          type: "string",
          enum: ["intranet", "public_web"],
          description: "intranet (default) = internal reader; public_web = public site (needs approval).",
        },
      },
      additionalProperties: false,
    }),
    execute: async (toolArgs): Promise<Record<string, unknown>> =>
      runWorkspacePublishOp({
        op,
        objectId,
        kind,
        userId,
        requestId,
        destinationRaw: toolArgs?.destination,
        log,
      }),
  });
}

/**
 * Build the hard-delete tool for the WORKSPACE-bound object. Bound only when the
 * session user can edit (owner/admin) the open object; the service re-checks
 * canView (404-mask) → canDelete (owner/admin 403) → live-publication (409) on
 * every call, so this is never a bypass. Runs as the SESSION user (`kind: "user"`),
 * so a human can only delete content they own (or as admin) via chat.
 */
function buildDeleteTool(args: {
  objectId: string;
  kind: "document" | "artifact";
  userId: number;
  log: ReturnType<typeof createLogger>;
}): Tool {
  const { objectId, kind, userId, log } = args;
  return tool({
    description:
      `PERMANENTLY delete the ${kind} open in the workspace panel — it and ALL its ` +
      `versions, comments, and history are removed and CANNOT be recovered (this is ` +
      `not archive). Only call this when the user has EXPLICITLY asked to permanently ` +
      `delete this ${kind}; if there is any doubt, ask them to confirm first. It is ` +
      `refused (returns blocked:true with a message) while the ${kind} is published ` +
      `anywhere — then tell the user to unpublish it first. Only the owner or an ` +
      `administrator may delete.`,
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async (): Promise<Record<string, unknown>> => {
      const req = await requesterForUserId(userId);
      if (!req) return { error: "Could not resolve your identity." };
      try {
        const deleted = await contentService.delete(req, objectId, {
          surface: "ui",
        });
        log.info("workspace content deleted via chat", { objectId, kind });
        return {
          ok: true,
          deleted: true,
          title: deleted.title,
          kind: deleted.kind,
          message:
            `Deleted "${deleted.title}". It is permanently gone; the workspace panel ` +
            `will show it is no longer available.`,
        };
      } catch (err) {
        // A live-publication refusal (409) is an ACTIONABLE, honest state — surface
        // its message so the model tells the user to unpublish first, not a failure.
        if (err instanceof ConflictError) {
          return { blocked: true, reason: "published", message: err.message };
        }
        // 403 (not owner/admin) and 404 (existence-masked) are permission outcomes,
        // reported without leaking which one it was beyond what the user may know.
        if (err instanceof ForbiddenError) {
          return {
            error:
              "You do not have permission to delete this item — only its owner or an administrator can.",
          };
        }
        if (err instanceof NotFoundError) {
          return { error: "That item is no longer available." };
        }
        log.warn("workspace delete failed", {
          objectId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { error: "The item could not be deleted right now." };
      }
    },
  });
}

/** Build the find-documents tool (ITEM 3): list Atrium documents the user can edit. */
function buildFindDocumentsTool(userId: number, log: ReturnType<typeof createLogger>): Tool {
  return tool({
    description:
      "Find Atrium documents the current user can EDIT, so you can then edit one that is NOT the document open in the workspace panel. Optionally filter by a title search. Returns id, title and slug for each match — pass the id to edit_atrium_document.",
    inputSchema: jsonSchema<{ query?: string }>({
      type: "object",
      properties: {
        query: { type: "string", description: "Optional case-insensitive title search." },
      },
      additionalProperties: false,
    }),
    execute: async (args): Promise<{ documents: Array<{ id: string; title: string; slug: string }> } | { error: string }> => {
      const req = await requesterForUserId(userId);
      if (!req) return { error: "Could not resolve your identity." };
      const query = typeof args?.query === "string" && args.query.trim() ? args.query.trim().slice(0, 200) : undefined;
      try {
        // list is visibility-gated (listVisible) — it only returns objects the user
        // can VIEW. Narrow to the ones they can EDIT with the same canEdit predicate
        // the editor uses (never a bypass), and cap the payload.
        const objs = await contentService.list(req, { kind: "document", ...(query ? { query } : {}) });
        const documents = objs
          .filter((o) => canEdit(req, o.ownerUserId))
          .slice(0, 25)
          .map((o) => ({ id: o.id, title: o.title, slug: o.slug }));
        return { documents };
      } catch (err) {
        log.warn("find_atrium_documents failed", { error: err instanceof Error ? err.message : String(err) });
        return { error: "The document list could not be loaded right now." };
      }
    },
  });
}

/** Build the edit-existing-document tool (ITEM 3): edit any document the user can edit, by id/slug. */
function buildEditDocumentByIdTool(
  userId: number,
  requestId: string,
  log: ReturnType<typeof createLogger>
): Tool {
  return tool({
    description:
      "Edit an EXISTING Atrium document that is NOT the one open in the workspace panel, identified by its id or slug (use find_atrium_documents to get ids). Your markdown is written into that document's live content, attributed to the assistant. mode 'append' (default) adds to the end; 'replace' rewrites the whole document.",
    inputSchema: jsonSchema<{ documentId: string; markdown: string; mode?: "append" | "replace" }>({
      type: "object",
      properties: {
        documentId: { type: "string", description: "The id or slug of the document to edit." },
        markdown: { type: "string", description: "The markdown to write into that document." },
        mode: {
          type: "string",
          enum: ["append", "replace"],
          description: "append (default) adds blocks at the end; replace rewrites the whole document.",
        },
      },
      required: ["documentId", "markdown"],
      additionalProperties: false,
    }),
    execute: async (args): Promise<{ ok: true; mode: string } | { error: string }> => {
      const documentId = typeof args?.documentId === "string" ? args.documentId.trim() : "";
      const markdown = typeof args?.markdown === "string" ? args.markdown : "";
      const mode = args?.mode === "replace" ? "replace" : "append";
      if (!documentId) return { error: "No document id or slug was provided." };
      const req = await requesterForUserId(userId);
      if (!req) return { error: "Could not resolve your identity." };
      // Resolve + canView-gate (contentService.get 404-masks a non-viewable object),
      // then require canEdit — the same predicates the editor/agent-bridge enforce.
      let obj: Awaited<ReturnType<typeof contentService.get>>;
      try {
        obj = await contentService.get(req, documentId);
      } catch (err) {
        // A NotFoundError here is the EXPECTED existence-mask (non-viewable target),
        // so log at info — not warn — mirroring buildWorkspaceChatTools' bind-time
        // catch. Logging keeps a genuine system fault (DB timeout, internal error)
        // diagnosable instead of swallowed, without spamming warnings on routine
        // authz misses (gemini review).
        log.info("edit_atrium_document: target not viewable/available", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { error: "No document with that id or slug is available to you." };
      }
      if (obj.kind !== "document") {
        return { error: "That item is not a document — only documents can be edited this way." };
      }
      if (!canEdit(req, obj.ownerUserId)) {
        return { error: "You do not have edit access to that document." };
      }
      return screenAndApplyDocEdit(obj.id, markdown, mode, requestId, log);
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
    // ITEM 2: publish/unpublish the OPEN object through the human publish gate.
    tools.publish_workspace_content = buildPublishTool({ op: "publish", objectId: obj.id, kind, userId, requestId, log });
    tools.unpublish_workspace_content = buildPublishTool({ op: "unpublish", objectId: obj.id, kind, userId, requestId, log });
  }

  // Hard delete of the OPEN object, bound on `canDelete` — NOT `canEdit`. helpers.ts
  // documents canDelete as deliberately decoupled from canEdit (owner/admin only, so a
  // future widening of edit — e.g. collaborator grants — can never silently imply
  // delete). canDelete === canEdit for a session user today, but binding the LLM's
  // delete affordance on the delete authority keeps it aligned with that discipline;
  // the service still re-checks assertCanDelete + the live-publication guard per call.
  if (canDelete(req, obj.ownerUserId)) {
    tools.delete_workspace_content = buildDeleteTool({ objectId: obj.id, kind, userId, log });
  }

  // ITEM 3: let the agent find and edit OTHER Atrium documents the user can edit —
  // not just the one bound via `?workspace=`. Both tools resolve their target and
  // re-check canView/canEdit PER CALL (never a bypass), so they are safe to expose
  // whenever a workspace is open, independent of the bound object's own editability.
  tools.find_atrium_documents = buildFindDocumentsTool(userId, log);
  tools.edit_atrium_document = buildEditDocumentByIdTool(userId, requestId, log);

  const editHint = editable
    ? kind === "document"
      ? " You can edit it with the edit_workspace_document tool; your edits appear live in the panel." +
        " You can also publish or unpublish it with publish_workspace_content / unpublish_workspace_content." +
        " If the user EXPLICITLY asks to permanently delete it (not archive), use delete_workspace_content — it is irreversible and refused while the document is published."
      : " You can update it with the update_workspace_artifact tool (provide the complete new code)." +
        " You can also publish or unpublish it with publish_workspace_content / unpublish_workspace_content." +
        " If the user EXPLICITLY asks to permanently delete it (not archive), use delete_workspace_content — it is irreversible and refused while the artifact is published."
    : " It is read-only for this user.";

  // Escape the title via JSON.stringify: a content title is user-controlled and
  // is interpolated into a SYSTEM instruction block, so a raw title with
  // newlines/quotes could inject prompt structure (PR #1136 review, Copilot).
  const safeTitle = JSON.stringify(obj.title);
  const systemPromptFragment =
    `A ${kind} titled ${safeTitle} is open in the workspace panel beside this chat. ` +
    `When the user asks you to change, add to, or fix it, act on THAT ${kind} rather than answering in chat only. ` +
    `Call read_workspace_content first to see its current content.` +
    editHint +
    ` To work on a DIFFERENT Atrium document, use find_atrium_documents to locate it and edit_atrium_document to change it (only documents the user can edit).`;

  log.info("Workspace chat tools bound", {
    objectId: obj.id,
    kind,
    editable,
    toolCount: Object.keys(tools).length,
  });

  return { tools, systemPromptFragment };
}
