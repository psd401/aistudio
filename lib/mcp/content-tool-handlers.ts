/**
 * Atrium content MCP tool handlers (Issue #1055, Phase 5 §24)
 *
 * Thin adapters: each builds a content `Requester` from the MCP session
 * (`requesterFromApiAuth`), validates input with Zod, calls the §11–§15 service,
 * writes an audit row, and maps `ContentError`s to a structured `McpToolResult`.
 * `publish_content` to a public destination without the human-held
 * `content:publish_public` surfaces a structured `approval_required` signal the
 * agent can relay — never a silent failure (§26.4).
 *
 * Scopes are enforced in the JSON-RPC dispatcher (`TOOL_SCOPE_MAP`) BEFORE these
 * run; the requester established here governs ownership/visibility/the gate.
 */

import { z } from "zod";
import {
  ApprovalRequiredError,
  contentService,
  hasPublishPublicScope,
  isContentError,
  publishService,
  recordContentAudit,
  requesterFromApiAuth,
  visibilityService,
  type ContentAuditAction,
  type Requester,
} from "@/lib/content";
import {
  assertContentAuthoringCapability,
  contentDeepLink,
  resolveCollectionId,
} from "@/lib/content/surface-helpers";
// Reuse the REST-side schemas verbatim so MCP and REST validate the same grant /
// visibility contract from ONE definition (they were byte-identical copies).
import {
  restGrantSchema as grantZ,
  restVisibilitySchema as visibilityZ,
} from "@/lib/content/rest";
import type { PublishDestination } from "@/lib/content/publish-adapters/types";
import type { McpToolContext, McpToolHandler, McpToolResult } from "./types";

// ============================================
// Result + error helpers
// ============================================

function ok(payload: Record<string, unknown>): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function zodFail(error: z.ZodError): McpToolResult {
  const issues = error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return {
    content: [{ type: "text", text: `Validation failed: ${issues}` }],
    isError: true,
  };
}

/** Map an error to a result WITHOUT auditing — for read paths (get/list), which
 * §27 does not audit. */
function failRead(err: unknown): McpToolResult {
  if (isContentError(err)) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: err.code, message: err.message }) },
      ],
      isError: true,
    };
  }
  return {
    content: [
      { type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
    ],
    isError: true,
  };
}

/**
 * Map a thrown error to a result AND record the audit outcome. An
 * `ApprovalRequiredError` is a structured (non-error) approval signal; any other
 * `ContentError` maps to `{ error: code }`; anything else to a generic message.
 */
async function fail(
  err: unknown,
  opts: {
    req?: Requester;
    action: ContentAuditAction;
    requestId: string;
    objectId?: string | null;
    destination?: PublishDestination;
  }
): Promise<McpToolResult> {
  const isApproval = err instanceof ApprovalRequiredError;
  if (opts.req) {
    void recordContentAudit({
      req: opts.req,
      action: opts.action,
      surface: "mcp",
      objectId: opts.objectId ?? null,
      destination: opts.destination,
      outcome: isApproval ? "approval_required" : "error",
      error: err instanceof Error ? err.message : String(err),
      requestId: opts.requestId,
    });
  }
  if (err instanceof ApprovalRequiredError) {
    return ok({ status: "approval_required", message: err.message });
  }
  if (isContentError(err)) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: err.code, message: err.message }) },
      ],
      isError: true,
    };
  }
  return {
    content: [
      { type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
    ],
    isError: true,
  };
}

/** Resolve the requester or return an error result when the identity is unusable. */
async function resolveReq(
  context: McpToolContext
): Promise<{ req: Requester } | { result: McpToolResult }> {
  try {
    return { req: await requesterFromApiAuth(context) };
  } catch (err) {
    return {
      result: {
        content: [
          {
            type: "text",
            text: `Unable to resolve caller identity: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      },
    };
  }
}

// ============================================
// Handlers
// ============================================

const createDocumentSchema = z.object({
  // Length caps mirror the REST createBodySchema (title→content_objects.title
  // varchar(500), collection→200) so both surfaces reject oversized input at the
  // schema boundary rather than only at the service/DB layer.
  title: z.string().min(1).max(500),
  collection: z.string().min(1).max(200).optional(),
  markdown: z.string().optional(),
  visibility: visibilityZ.optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * Shared create flow for the document + artifact tools (they differ only in
 * `kind` and how body/bodyFormat map from each tool's own schema). Resolves the
 * requester, enforces the session capability gate + the §26.4 public-publish
 * gate, creates, audits, and maps errors — in ONE place so the two thin handlers
 * can't drift on the shared logic.
 */
async function createContent(
  context: McpToolContext,
  kind: "document" | "artifact",
  common: {
    title: string;
    collection?: string;
    visibility?: z.infer<typeof visibilityZ>;
    tags?: string[];
  },
  body: { body?: string; bodyFormat?: "markdown" | "html" | "jsx" }
): Promise<McpToolResult> {
  const resolved = await resolveReq(context);
  if ("result" in resolved) return resolved.result;
  const { req } = resolved;
  try {
    // Session humans must also hold the atrium-content capability (see helper).
    await assertContentAuthoringCapability(context);
    const collectionId = await resolveCollectionId(common.collection);
    const hasPublishPublicCapability = hasPublishPublicScope(context.scopes);
    const created = await contentService.create(
      req,
      {
        kind,
        title: common.title,
        collectionId,
        body: body.body,
        bodyFormat: body.bodyFormat,
        visibility: common.visibility,
        tags: common.tags,
      },
      { hasPublishPublicCapability }
    );
    void recordContentAudit({
      req,
      action: "create",
      surface: "mcp",
      objectId: created.id,
      outcome: "ok",
      requestId: context.requestId,
    });
    return ok({ id: created.id, slug: created.slug, url: contentDeepLink(created.slug) });
  } catch (err) {
    return fail(err, { req, action: "create", requestId: context.requestId });
  }
}

async function handleCreateDocument(
  args: Record<string, unknown>,
  context: McpToolContext
): Promise<McpToolResult> {
  const parsed = createDocumentSchema.safeParse(args);
  if (!parsed.success) return zodFail(parsed.error);
  const { title, collection, markdown, visibility, tags } = parsed.data;
  return createContent(
    context,
    "document",
    { title, collection, visibility, tags },
    { body: markdown, bodyFormat: markdown ? "markdown" : undefined }
  );
}

const createArtifactSchema = z.object({
  // Length caps mirror the REST createBodySchema (see createDocumentSchema).
  title: z.string().min(1).max(500),
  collection: z.string().min(1).max(200).optional(),
  code: z.string().min(1),
  bodyFormat: z.enum(["html", "jsx"]),
  visibility: visibilityZ.optional(),
  tags: z.array(z.string()).optional(),
});

async function handleCreateArtifact(
  args: Record<string, unknown>,
  context: McpToolContext
): Promise<McpToolResult> {
  const parsed = createArtifactSchema.safeParse(args);
  if (!parsed.success) return zodFail(parsed.error);
  const { title, collection, code, bodyFormat, visibility, tags } = parsed.data;
  return createContent(
    context,
    "artifact",
    { title, collection, visibility, tags },
    { body: code, bodyFormat }
  );
}

const getContentSchema = z.object({ idOrSlug: z.string().min(1) });

async function handleGetContent(
  args: Record<string, unknown>,
  context: McpToolContext
): Promise<McpToolResult> {
  const parsed = getContentSchema.safeParse(args);
  if (!parsed.success) return zodFail(parsed.error);
  const resolved = await resolveReq(context);
  if ("result" in resolved) return resolved.result;
  const { req } = resolved;
  try {
    const obj = await contentService.get(req, parsed.data.idOrSlug);
    return ok({
      id: obj.id,
      slug: obj.slug,
      kind: obj.kind,
      title: obj.title,
      status: obj.status,
      visibilityLevel: obj.visibilityLevel,
      tags: obj.tags,
      currentVersion: obj.version
        ? {
            id: obj.version.id,
            versionNumber: obj.version.versionNumber,
            bodyFormat: obj.version.bodyFormat,
            authorActor: obj.version.authorActor,
          }
        : null,
      url: contentDeepLink(obj.slug),
    });
  } catch (err) {
    return failRead(err);
  }
}

const listContentSchema = z.object({
  kind: z.enum(["document", "artifact"]).optional(),
  collection: z.string().min(1).optional(),
  tag: z.string().optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
});

async function handleListContent(
  args: Record<string, unknown>,
  context: McpToolContext
): Promise<McpToolResult> {
  const parsed = listContentSchema.safeParse(args);
  if (!parsed.success) return zodFail(parsed.error);
  const resolved = await resolveReq(context);
  if ("result" in resolved) return resolved.result;
  const { req } = resolved;
  try {
    const collectionId = await resolveCollectionId(parsed.data.collection);
    const items = await contentService.list(req, {
      kind: parsed.data.kind,
      collectionId,
      tag: parsed.data.tag,
      status: parsed.data.status,
    });
    return ok({
      items: items.map((o) => ({
        id: o.id,
        slug: o.slug,
        kind: o.kind,
        title: o.title,
        status: o.status,
        visibilityLevel: o.visibilityLevel,
      })),
    });
  } catch (err) {
    return failRead(err);
  }
}

const updateContentSchema = z.object({
  id: z.string().min(1),
  // title cap mirrors the REST PATCH schema (content_objects.title varchar(500)).
  title: z.string().min(1).max(500).optional(),
  tags: z.array(z.string()).nullable().optional(),
  collection: z.string().min(1).max(200).nullable().optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
});

async function handleUpdateContent(
  args: Record<string, unknown>,
  context: McpToolContext
): Promise<McpToolResult> {
  const parsed = updateContentSchema.safeParse(args);
  if (!parsed.success) return zodFail(parsed.error);
  const resolved = await resolveReq(context);
  if ("result" in resolved) return resolved.result;
  const { req } = resolved;
  try {
    // Session humans must also hold the atrium-content capability (see helper).
    await assertContentAuthoringCapability(context);
    // A null collection clears it; an omitted one leaves it unchanged.
    const collectionId =
      parsed.data.collection === undefined
        ? undefined
        : parsed.data.collection === null
          ? null
          : await resolveCollectionId(parsed.data.collection);
    const updated = await contentService.update(req, parsed.data.id, {
      title: parsed.data.title,
      tags: parsed.data.tags,
      collectionId,
      status: parsed.data.status,
    });
    void recordContentAudit({
      req,
      action: "update",
      surface: "mcp",
      objectId: parsed.data.id,
      outcome: "ok",
      requestId: context.requestId,
    });
    return ok({ id: updated.id, slug: updated.slug, status: updated.status });
  } catch (err) {
    return fail(err, {
      req,
      action: "update",
      objectId: parsed.data.id,
      requestId: context.requestId,
    });
  }
}

const createVersionSchema = z.object({
  id: z.string().min(1),
  body: z.string().min(1),
  bodyFormat: z.enum(["markdown", "html", "jsx"]).optional(),
  summary: z.string().optional(),
});

async function handleCreateVersion(
  args: Record<string, unknown>,
  context: McpToolContext
): Promise<McpToolResult> {
  const parsed = createVersionSchema.safeParse(args);
  if (!parsed.success) return zodFail(parsed.error);
  const resolved = await resolveReq(context);
  if ("result" in resolved) return resolved.result;
  const { req } = resolved;
  try {
    // Session humans must also hold the atrium-content capability (see helper).
    await assertContentAuthoringCapability(context);
    const result = await contentService.createVersion(req, parsed.data.id, {
      body: parsed.data.body,
      bodyFormat: parsed.data.bodyFormat,
      summary: parsed.data.summary,
    });
    void recordContentAudit({
      req,
      action: "create_version",
      surface: "mcp",
      objectId: parsed.data.id,
      outcome: "ok",
      requestId: context.requestId,
    });
    return ok({
      id: result.id,
      slug: result.slug,
      versionId: result.version?.id ?? null,
      versionNumber: result.version?.versionNumber ?? null,
    });
  } catch (err) {
    return fail(err, {
      req,
      action: "create_version",
      objectId: parsed.data.id,
      requestId: context.requestId,
    });
  }
}

const setVisibilitySchema = z.object({
  id: z.string().min(1),
  level: z.enum(["private", "group", "internal", "public"]),
  grants: z.array(grantZ).optional(),
});

async function handleSetVisibility(
  args: Record<string, unknown>,
  context: McpToolContext
): Promise<McpToolResult> {
  const parsed = setVisibilitySchema.safeParse(args);
  if (!parsed.success) return zodFail(parsed.error);
  const resolved = await resolveReq(context);
  if ("result" in resolved) return resolved.result;
  const { req } = resolved;
  try {
    // Session humans must also hold the atrium-content capability (see helper).
    await assertContentAuthoringCapability(context);
    // Lean load: existence-mask (404) + edit gate, no version join (setLevel
    // re-selects the row FOR UPDATE). Widening to `public` is additionally gated
    // inside `setLevel` itself (§26.4) — same authority key as `publish_content`:
    // an EXPLICIT content:publish_public scope, never the session wildcard.
    const obj = await contentService.loadForEdit(req, parsed.data.id);
    const hasPublishPublicCapability = hasPublishPublicScope(context.scopes);
    const result = await visibilityService.setLevel(
      req,
      obj.id,
      { level: parsed.data.level, grants: parsed.data.grants },
      { hasPublishPublicCapability }
    );
    void recordContentAudit({
      req,
      action: "set_visibility",
      surface: "mcp",
      objectId: obj.id,
      outcome: "ok",
      requestId: context.requestId,
    });
    return ok({ id: obj.id, level: result.visibilityLevel });
  } catch (err) {
    // fail() already maps ApprovalRequiredError to an audited
    // ok({ status: "approval_required" }) result (its §26.4 branch), so route the
    // catch through it rather than inlining a second copy that could drift.
    return fail(err, {
      req,
      action: "set_visibility",
      objectId: parsed.data.id,
      requestId: context.requestId,
    });
  }
}

const publishContentSchema = z.object({
  id: z.string().min(1),
  destination: z.enum(["intranet", "public_web", "schoology", "google"]),
});

async function handlePublishContent(
  args: Record<string, unknown>,
  context: McpToolContext
): Promise<McpToolResult> {
  const parsed = publishContentSchema.safeParse(args);
  if (!parsed.success) return zodFail(parsed.error);
  const resolved = await resolveReq(context);
  if ("result" in resolved) return resolved.result;
  const { req } = resolved;
  const destination = parsed.data.destination;
  try {
    // Session humans must also hold the atrium-content capability (see helper).
    await assertContentAuthoringCapability(context);
    // The public-publish gate is keyed to authority: an API/MCP caller's EXPLICIT
    // content:publish_public scope. A session's wildcard ["*"] must NOT auto-grant
    // it (every logged-in human would otherwise bypass the gate) — admin humans
    // still pass via req.isAdmin inside the service.
    const hasPublishPublicCapability = hasPublishPublicScope(context.scopes);
    const result = await publishService.publish(
      req,
      parsed.data.id,
      { destination },
      { hasPublishPublicCapability }
    );
    void recordContentAudit({
      req,
      action: "publish",
      surface: "mcp",
      objectId: parsed.data.id,
      destination,
      outcome: "ok",
      requestId: context.requestId,
    });
    return ok({
      id: parsed.data.id,
      destination,
      publishedVersionId: result.publishedVersionId,
    });
  } catch (err) {
    return fail(err, {
      req,
      action: "publish",
      objectId: parsed.data.id,
      destination,
      requestId: context.requestId,
    });
  }
}

export const CONTENT_TOOL_HANDLERS: Record<string, McpToolHandler> = {
  create_document: handleCreateDocument,
  create_artifact: handleCreateArtifact,
  get_content: handleGetContent,
  list_content: handleListContent,
  update_content: handleUpdateContent,
  create_version: handleCreateVersion,
  set_visibility: handleSetVisibility,
  publish_content: handlePublishContent,
};
