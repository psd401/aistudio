/**
 * Atrium Content Collection Endpoint (Issue #1055, Phase 5 §23)
 * GET  /api/v1/content — list content the caller may view (permission-filtered)
 * POST /api/v1/content — create a content object (does not publish)
 *
 * Mirrors the MCP create_document/create_artifact + list_content tools 1:1 over
 * REST, following the v1 conventions (sk- keys / OIDC bearer, requireScope, the
 * standard envelope). Identity is resolved by `requesterFromApiAuth`.
 */

import { NextRequest } from "next/server";
import {
  withApiAuth,
  requireScope,
  createApiResponse,
  createErrorResponse,
  parseRequestBody,
} from "@/lib/api";
import { z } from "zod";
import {
  contentService,
  hasPublishPublicScope,
  recordContentAudit,
  requesterFromApiAuth,
} from "@/lib/content";
import {
  contentErrorToResponse,
  resolveRestRequester,
  restVisibilitySchema,
} from "@/lib/content/rest";
import {
  assertContentAuthoringCapability,
  contentDeepLink,
  resolveCollectionId,
} from "@/lib/content/surface-helpers";
import { decodeContentBody } from "@/lib/content/code-encoding";
import { createLogger } from "@/lib/logger";

const listQuerySchema = z.object({
  kind: z.enum(["document", "artifact"]).optional(),
  collection: z.string().min(1).max(200).optional(),
  tag: z.string().min(1).max(100).optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
  // Case-insensitive title search (service-side ILIKE); bounded at 200 chars —
  // same contract as the MCP list_content tool.
  query: z.string().min(1).max(200).optional(),
});

const createBodySchema = z.object({
  kind: z.enum(["document", "artifact"]),
  title: z.string().min(1).max(500),
  collectionId: z.string().min(1).optional(),
  body: z.string().optional(),
  bodyFormat: z.enum(["markdown", "html", "jsx"]).optional(),
  // Transit encoding for `body`. Send `"base64"` so artifact code containing
  // <script>/<style> is opaque to the ALB WAF's CrossSiteScripting_BODY rule; the
  // server decodes it here BEFORE §28.3 screening / size caps. Omit for raw text.
  codeEncoding: z.enum(["base64"]).optional(),
  visibility: restVisibilitySchema.optional(),
  tags: z.array(z.string()).optional(),
});

// ============================================
// GET — list visible content
// ============================================

export const GET = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "content:read", requestId);
  if (scopeError) return scopeError;

  const log = createLogger({ requestId, route: "api.v1.content.list" });

  const { searchParams } = new URL(request.url);
  const parsed = listQuerySchema.safeParse(
    Object.fromEntries(searchParams.entries())
  );
  if (!parsed.success) {
    return createErrorResponse(
      requestId,
      400,
      "VALIDATION_ERROR",
      "Invalid query parameters",
      parsed.error.issues
    );
  }

  try {
    const req = await requesterFromApiAuth(auth);
    const collectionId = await resolveCollectionId(parsed.data.collection);
    const items = await contentService.list(req, {
      kind: parsed.data.kind,
      collectionId,
      tag: parsed.data.tag,
      status: parsed.data.status,
      query: parsed.data.query,
    });
    return createApiResponse(
      { data: items, meta: { requestId, count: items.length } },
      requestId
    );
  } catch (err) {
    log.error("Failed to list content", {
      error: err instanceof Error ? err.message : String(err),
    });
    return contentErrorToResponse(err, requestId);
  }
});

// ============================================
// POST — create a content object
// ============================================

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "content:create", requestId);
  if (scopeError) return scopeError;

  const log = createLogger({ requestId, route: "api.v1.content.create" });

  const parsedBody = await parseRequestBody(request, createBodySchema, requestId);
  if (parsedBody instanceof Response) return parsedBody;
  const input = parsedBody.data;

  const resolved = await resolveRestRequester(auth, requestId);
  if ("response" in resolved) return resolved.response;
  const { req } = resolved;

  // Same authority key as publish/set_visibility: an EXPLICIT content:publish_public
  // scope, never a session's wildcard ["*"] (admin humans pass via req.isAdmin).
  const hasPublishPublicCapability = hasPublishPublicScope(auth.scopes);

  try {
    // Session humans must ALSO hold the atrium-content capability (scope alone is
    // the wildcard ["*"] for a session); sk-/OIDC callers are gated by scope.
    await assertContentAuthoringCapability(auth);
    // Decode a base64 (WAF-opaque) body to its real content BEFORE the service's
    // §28.3 screening + size caps run — screening always sees decoded content.
    // Invalid base64 / over-cap throws a ValidationError (mapped to 400 below).
    const body = decodeContentBody(input.body, input.codeEncoding);
    const collectionId = await resolveCollectionId(input.collectionId);
    const created = await contentService.create(
      req,
      {
        kind: input.kind,
        title: input.title,
        collectionId,
        body,
        bodyFormat: input.bodyFormat,
        visibility: input.visibility,
        tags: input.tags,
      },
      { hasPublishPublicCapability }
    );
    void recordContentAudit({
      req,
      action: "create",
      surface: "rest",
      objectId: created.id,
      outcome: "ok",
      requestId,
    });
    // §26.4 create-as-private (issue #1118 item 2): an unauthorized public create
    // is NOT rejected — `contentService.create` returns the object created PRIVATE
    // and queues a durable `visibility_widen` request. The response reflects
    // `visibilityLevel: "private"`; a caller wanting public awaits admin approval.
    log.info("Created content via REST", {
      objectId: created.id,
      kind: input.kind,
      visibilityLevel: created.visibilityLevel,
    });
    return createApiResponse(
      { data: { ...created, url: contentDeepLink(created.slug) }, meta: { requestId } },
      requestId,
      201
    );
  } catch (err) {
    void recordContentAudit({
      req,
      action: "create",
      surface: "rest",
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return contentErrorToResponse(err, requestId);
  }
});
