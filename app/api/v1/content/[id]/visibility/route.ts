/**
 * Atrium Content Visibility Endpoint (Issue #1055, Phase 5 §23, §26.4)
 * GET   /api/v1/content/:id/visibility — read visibility level + group grants
 * PATCH /api/v1/content/:id/visibility — set visibility level + group grants
 *
 * Mirrors the MCP set_visibility tool. The route loads the object (enforces
 * canView, 404-masks) and gates edit before mutating; widening to `public`
 * additionally requires `content:publish_public` — enforced inside
 * `visibilityService.setLevel` itself (§26.4), surfacing a structured 202
 * `approval_required` here just like the publish endpoint.
 */

import { NextRequest } from "next/server";
import {
  withApiAuth,
  requireScope,
  createApiResponse,
  createErrorResponse,
  parseRequestBody,
} from "@/lib/api";
import {
  ApprovalRequiredError,
  contentService,
  hasPublishPublicScope,
  recordContentAudit,
  visibilityService,
} from "@/lib/content";
import {
  contentErrorToResponse,
  resolveRestRequester,
  respondApprovalRequired,
  restVisibilitySchema,
} from "@/lib/content/rest";
import { assertContentAuthoringCapability } from "@/lib/content/surface-helpers";
import { createLogger } from "@/lib/logger";

/**
 * GET — the CURRENT level plus the actual grant entries (#1763).
 *
 * `GET /api/v1/content/:id` exposes only a `grantCount` integer, and the PATCH
 * below REPLACES the grant set rather than merging into it. Without a read the
 * only way to narrow or widen an object is to re-send a guessed grant list, and
 * a wrong guess silently drops access that no audit trail can restore.
 *
 * Gated on EDIT, not view, via `loadForEdit` (404-masks a non-viewable object
 * before the 403). The grant set names every principal with access — including
 * the numeric `users.id` behind a `user` grant — which an owner never intended
 * to expose to grantees, so a caller who can only VIEW the object must not be
 * able to enumerate its grants. This mirrors `getVisibilityAction`, which also
 * returns grants to editors only.
 *
 * Deliberately does NOT call `assertContentAuthoringCapability`: that gate
 * exists for authoring writes, and reading back an object you already own is
 * not authoring. Adding it here would hide an owner's own audience from them
 * over a capability that only governs mutation.
 */
export const GET = withApiAuth(async (request: NextRequest, auth, requestId, params) => {
  const scopeError = requireScope(auth, "content:read", requestId);
  if (scopeError) return scopeError;

  const id = params.id;
  if (!id) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Missing content id");
  }

  const resolved = await resolveRestRequester(auth, requestId);
  if ("response" in resolved) return resolved.response;
  const { req } = resolved;

  try {
    const obj = await contentService.loadForEdit(req, id);
    const grants = await visibilityService.grantsFor(obj.id);
    return createApiResponse(
      {
        data: {
          id: obj.id,
          visibility: { visibilityLevel: obj.visibilityLevel, grants },
        },
        meta: { requestId },
      },
      requestId
    );
  } catch (err) {
    return contentErrorToResponse(err, requestId);
  }
});

export const PATCH = withApiAuth(async (request: NextRequest, auth, requestId, params) => {
  const scopeError = requireScope(auth, "content:update", requestId);
  if (scopeError) return scopeError;

  const log = createLogger({ requestId, route: "api.v1.content.setVisibility" });

  // Real Next.js [id] route param — collision-free vs. parsing the URL by segment.
  const id = params.id;
  if (!id) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Missing content id");
  }

  const parsedBody = await parseRequestBody(request, restVisibilitySchema, requestId);
  if (parsedBody instanceof Response) return parsedBody;
  const input = parsedBody.data;

  const resolved = await resolveRestRequester(auth, requestId);
  if ("response" in resolved) return resolved.response;
  const { req } = resolved;

  // Same authority key as the publish endpoint: an EXPLICIT content:publish_public
  // scope, never a session's wildcard ["*"] (admin humans pass via req.isAdmin).
  const hasPublishPublicCapability = hasPublishPublicScope(auth.scopes);

  try {
    // Session humans must also hold the atrium-content capability (see helper).
    await assertContentAuthoringCapability(auth);
    // Lean load: existence-mask (404) + edit gate, no version join (setLevel
    // re-selects the row FOR UPDATE).
    const obj = await contentService.loadForEdit(req, id);
    const result = await visibilityService.setLevel(
      req,
      obj.id,
      { level: input.level, grants: input.grants },
      { hasPublishPublicCapability }
    );
    void recordContentAudit({
      req,
      action: "set_visibility",
      surface: "rest",
      objectId: obj.id,
      outcome: "ok",
      requestId,
    });
    log.info("Set visibility via REST", { objectId: obj.id, level: result.visibilityLevel });
    return createApiResponse(
      // Project the field explicitly — `setLevel` also returns `becamePublic`,
      // an internal allow-then-notify signal that is not part of the documented
      // v1 response body (docs/API/v1/openapi.yaml).
      {
        data: {
          id: obj.id,
          visibility: { visibilityLevel: result.visibilityLevel },
        },
        meta: { requestId },
      },
      requestId
    );
  } catch (err) {
    if (err instanceof ApprovalRequiredError) {
      log.info("Public visibility widen requires approval", { objectId: id });
      return respondApprovalRequired(err, {
        req,
        action: "set_visibility",
        objectId: id,
        requestId,
      });
    }
    void recordContentAudit({
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
