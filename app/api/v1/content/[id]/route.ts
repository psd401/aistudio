/**
 * Atrium Content Item Endpoint (Issue #1055, Phase 5 §23)
 * GET   /api/v1/content/:id — object + current version (permission-checked)
 * PATCH /api/v1/content/:id — update metadata (title, tags, collection, status)
 *
 * Mirrors the MCP get_content + update_content tools.
 */

import { NextRequest } from "next/server";
import {
  withApiAuth,
  requireScope,
  createApiResponse,
  createErrorResponse,
  extractStringParam,
  parseRequestBody,
} from "@/lib/api";
import { z } from "zod";
import {
  contentService,
  recordContentAudit,
  requesterFromApiAuth,
} from "@/lib/content";
import { contentErrorToResponse } from "@/lib/content/rest";
import { contentDeepLink, resolveCollectionId } from "@/lib/content/surface-helpers";
import { createLogger } from "@/lib/logger";

const updateBodySchema = z.object({
  title: z.string().min(1).max(500).optional(),
  tags: z.array(z.string()).nullable().optional(),
  collectionId: z.string().nullable().optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
});

// ============================================
// GET — object + current version
// ============================================

export const GET = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "content:read", requestId);
  if (scopeError) return scopeError;

  const id = extractStringParam(request.url, "content");
  if (!id) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Missing content id");
  }

  try {
    const req = await requesterFromApiAuth(auth);
    const obj = await contentService.get(req, id);
    return createApiResponse(
      { data: { ...obj, url: contentDeepLink(obj.slug) }, meta: { requestId } },
      requestId
    );
  } catch (err) {
    return contentErrorToResponse(err, requestId);
  }
});

// ============================================
// PATCH — update metadata
// ============================================

export const PATCH = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "content:update", requestId);
  if (scopeError) return scopeError;

  const log = createLogger({ requestId, route: "api.v1.content.update" });

  const id = extractStringParam(request.url, "content");
  if (!id) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Missing content id");
  }

  const parsedBody = await parseRequestBody(request, updateBodySchema, requestId);
  if (parsedBody instanceof Response) return parsedBody;
  const patch = parsedBody.data;

  let req;
  try {
    req = await requesterFromApiAuth(auth);
  } catch (err) {
    return contentErrorToResponse(err, requestId);
  }

  try {
    // null clears the collection; undefined leaves it unchanged.
    const collectionId =
      patch.collectionId === undefined
        ? undefined
        : patch.collectionId === null
          ? null
          : await resolveCollectionId(patch.collectionId);
    const updated = await contentService.update(req, id, {
      title: patch.title,
      tags: patch.tags,
      collectionId,
      status: patch.status,
    });
    await recordContentAudit({
      req,
      action: "update",
      surface: "rest",
      objectId: id,
      outcome: "ok",
      requestId,
    });
    log.info("Updated content via REST", { objectId: id });
    return createApiResponse({ data: updated, meta: { requestId } }, requestId);
  } catch (err) {
    await recordContentAudit({
      req,
      action: "update",
      surface: "rest",
      objectId: id,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return contentErrorToResponse(err, requestId);
  }
});
