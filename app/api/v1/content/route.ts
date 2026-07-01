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
  ApprovalRequiredError,
  contentService,
  recordContentAudit,
  requesterFromApiAuth,
} from "@/lib/content";
import { contentErrorToResponse, restVisibilitySchema } from "@/lib/content/rest";
import { contentDeepLink, resolveCollectionId } from "@/lib/content/surface-helpers";
import { createLogger } from "@/lib/logger";

const listQuerySchema = z.object({
  kind: z.enum(["document", "artifact"]).optional(),
  collection: z.string().min(1).max(200).optional(),
  tag: z.string().min(1).max(100).optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
});

const createBodySchema = z.object({
  kind: z.enum(["document", "artifact"]),
  title: z.string().min(1).max(500),
  collectionId: z.string().min(1).optional(),
  body: z.string().optional(),
  bodyFormat: z.enum(["markdown", "html", "jsx"]).optional(),
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

  let req;
  try {
    req = await requesterFromApiAuth(auth);
  } catch (err) {
    return contentErrorToResponse(err, requestId);
  }

  // §26.4 gate: creating directly at `public` requires the EXPLICIT
  // content:publish_public scope (a session wildcard ["*"] must NOT auto-grant it).
  const hasPublishPublicCapability = auth.scopes.includes("content:publish_public");

  try {
    const collectionId = await resolveCollectionId(input.collectionId);
    const created = await contentService.create(
      req,
      {
        kind: input.kind,
        title: input.title,
        collectionId,
        body: input.body,
        bodyFormat: input.bodyFormat,
        visibility: input.visibility,
        tags: input.tags,
      },
      { hasPublishPublicCapability }
    );
    await recordContentAudit({
      req,
      action: "create",
      surface: "rest",
      objectId: created.id,
      outcome: "ok",
      requestId,
    });
    log.info("Created content via REST", { objectId: created.id, kind: input.kind });
    return createApiResponse(
      { data: { ...created, url: contentDeepLink(created.slug) }, meta: { requestId } },
      requestId,
      201
    );
  } catch (err) {
    // Creating public content the caller isn't authorized for is the §26.4
    // approval signal (202), mirroring the publish/visibility routes.
    if (err instanceof ApprovalRequiredError) {
      await recordContentAudit({
        req,
        action: "create",
        surface: "rest",
        outcome: "approval_required",
        error: err.message,
        requestId,
      });
      log.info("Public content creation requires approval", { kind: input.kind });
      return createApiResponse(
        { data: { status: "approval_required", message: err.message }, meta: { requestId } },
        requestId,
        202
      );
    }
    await recordContentAudit({
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
