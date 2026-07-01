/**
 * Atrium Content Visibility Endpoint (Issue #1055, Phase 5 §23)
 * PATCH /api/v1/content/:id/visibility — set visibility level + group grants
 *
 * Mirrors the MCP set_visibility tool. The standalone setLevel does no permission
 * check, so the route loads the object (enforces canView, 404-masks) and gates
 * edit before mutating.
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
import {
  ApprovalRequiredError,
  assertCanEdit,
  contentService,
  recordContentAudit,
  requesterFromApiAuth,
  visibilityService,
} from "@/lib/content";
import {
  contentErrorToResponse,
  restVisibilitySchema,
} from "@/lib/content/rest";
import { createLogger } from "@/lib/logger";

export const PATCH = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "content:update", requestId);
  if (scopeError) return scopeError;

  const log = createLogger({ requestId, route: "api.v1.content.setVisibility" });

  const id = extractStringParam(request.url, "content");
  if (!id) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Missing content id");
  }

  const parsedBody = await parseRequestBody(request, restVisibilitySchema, requestId);
  if (parsedBody instanceof Response) return parsedBody;
  const input = parsedBody.data;

  let req;
  try {
    req = await requesterFromApiAuth(auth);
  } catch (err) {
    return contentErrorToResponse(err, requestId);
  }

  // §26.4 gate: widening to `public` requires the EXPLICIT content:publish_public
  // scope (a session wildcard ["*"] must NOT auto-grant it). setLevel enforces it.
  const hasPublishPublicCapability = auth.scopes.includes("content:publish_public");

  try {
    const obj = await contentService.get(req, id);
    assertCanEdit(req, obj.ownerUserId);
    const result = await visibilityService.setLevel(
      req,
      obj.id,
      { level: input.level, grants: input.grants },
      { hasPublishPublicCapability }
    );
    await recordContentAudit({
      req,
      action: "set_visibility",
      surface: "rest",
      objectId: obj.id,
      outcome: "ok",
      requestId,
    });
    log.info("Set visibility via REST", { objectId: obj.id, level: result.visibilityLevel });
    return createApiResponse(
      { data: { id: obj.id, visibility: result }, meta: { requestId } },
      requestId
    );
  } catch (err) {
    // A public-widening the caller isn't authorized for is not an error but the
    // §26.4 approval signal (202), mirroring the publish route.
    if (err instanceof ApprovalRequiredError) {
      await recordContentAudit({
        req,
        action: "set_visibility",
        surface: "rest",
        objectId: id,
        outcome: "approval_required",
        error: err.message,
        requestId,
      });
      log.info("Public visibility requires approval", { objectId: id });
      return createApiResponse(
        { data: { status: "approval_required", message: err.message }, meta: { requestId } },
        requestId,
        202
      );
    }
    await recordContentAudit({
      req,
      action: "set_visibility",
      surface: "rest",
      objectId: id,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return contentErrorToResponse(err, requestId);
  }
});
