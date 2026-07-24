/**
 * Atrium Content Item Endpoint (Issue #1055, Phase 5 §23)
 * GET    /api/v1/content/:id — object + current version (permission-checked)
 * PATCH  /api/v1/content/:id — update metadata (title, tags, collection, status)
 * DELETE /api/v1/content/:id — hard-delete the object (owner/admin, no live pub)
 *
 * Mirrors the MCP get_content + update_content tools.
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
  contentHeadEtag,
  recordContentAudit,
  requesterFromApiAuth,
} from "@/lib/content";
import { contentErrorToResponse, resolveRestRequester } from "@/lib/content/rest";
import {
  assertContentAuthoringCapability,
  contentDeepLink,
  resolveCollectionId,
} from "@/lib/content/surface-helpers";
import { createLogger } from "@/lib/logger";

const updateBodySchema = z.object({
  title: z.string().min(1).max(500).optional(),
  tags: z.array(z.string()).nullable().optional(),
  // .min(1): an empty string must be a validation error, not silently treated as
  // "unchanged" (undefined). Use null to explicitly clear the collection.
  collectionId: z.string().min(1).nullable().optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
});

// ============================================
// GET — object + current version
// ============================================

export const GET = withApiAuth(async (request: NextRequest, auth, requestId, params) => {
  const scopeError = requireScope(auth, "content:read", requestId);
  if (scopeError) return scopeError;

  // Real Next.js [id] route param — collision-free vs. parsing the URL by segment
  // name (a slug of "content" would misparse with extractStringParam).
  const id = params.id;
  if (!id) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Missing content id");
  }

  try {
    const req = await requesterFromApiAuth(auth);
    const obj = await contentService.get(req, id);
    const response = createApiResponse(
      { data: { ...obj, url: contentDeepLink(obj.slug) }, meta: { requestId } },
      requestId
    );
    response.headers.set("ETag", contentHeadEtag(obj.currentVersionId));
    return response;
  } catch (err) {
    return contentErrorToResponse(err, requestId);
  }
});

// ============================================
// PATCH — update metadata
// ============================================

export const PATCH = withApiAuth(async (request: NextRequest, auth, requestId, params) => {
  const scopeError = requireScope(auth, "content:update", requestId);
  if (scopeError) return scopeError;

  const log = createLogger({ requestId, route: "api.v1.content.update" });

  const id = params.id;
  if (!id) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Missing content id");
  }

  const parsedBody = await parseRequestBody(request, updateBodySchema, requestId);
  if (parsedBody instanceof Response) return parsedBody;
  const patch = parsedBody.data;

  const resolved = await resolveRestRequester(auth, requestId);
  if ("response" in resolved) return resolved.response;
  const { req } = resolved;

  try {
    // Session humans must also hold the atrium-content capability (see helper).
    await assertContentAuthoringCapability(auth);
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
    void recordContentAudit({
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
    void recordContentAudit({
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

// ============================================
// DELETE — hard-delete the object
// ============================================

export const DELETE = withApiAuth(async (request: NextRequest, auth, requestId, params) => {
  const scopeError = requireScope(auth, "content:delete", requestId);
  if (scopeError) return scopeError;

  const log = createLogger({ requestId, route: "api.v1.content.delete" });

  const id = params.id;
  if (!id) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Missing content id");
  }

  const resolved = await resolveRestRequester(auth, requestId);
  if ("response" in resolved) return resolved.response;
  const { req } = resolved;

  try {
    // Session humans must also hold the atrium-content capability (see helper).
    await assertContentAuthoringCapability(auth);
    // The service writes the transactional SUCCESS audit (with title/kind/owner
    // details) inside the delete tx, so we deliberately do NOT recordContentAudit
    // on success here — only on the error path below, matching PATCH.
    const deleted = await contentService.delete(req, id, { surface: "rest" });
    log.info("Deleted content via REST", {
      objectId: deleted.id,
      versionsDeleted: deleted.versionsDeleted,
    });
    return createApiResponse({ data: deleted, meta: { requestId } }, requestId);
  } catch (err) {
    void recordContentAudit({
      req,
      action: "delete",
      surface: "rest",
      objectId: id,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return contentErrorToResponse(err, requestId);
  }
});
