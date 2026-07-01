/**
 * Atrium Content Unpublish Endpoint (Issue #1055, Phase 5 §23, §26.4)
 * DELETE /api/v1/content/:id/publish/:destination — unpublish from a destination
 *
 * Idempotent: unpublishing an object that is not live at the destination returns
 * `unpublished: false` rather than erroring. Taking down `public_web` requires
 * `content:publish_public` — the same authority needed to publish it — enforced
 * inside `publishService.unpublish`.
 */

import { NextRequest } from "next/server";
import {
  withApiAuth,
  requireScope,
  createApiResponse,
  createErrorResponse,
  extractStringParam,
} from "@/lib/api";
import {
  ApprovalRequiredError,
  hasPublishPublicScope,
  publishService,
  recordContentAudit,
} from "@/lib/content";
import {
  contentErrorToResponse,
  resolveRestRequester,
  respondApprovalRequired,
} from "@/lib/content/rest";
import { assertContentAuthoringCapability } from "@/lib/content/surface-helpers";
import type { PublishDestination } from "@/lib/content/publish-adapters/types";
import { createLogger } from "@/lib/logger";

const DESTINATIONS: PublishDestination[] = [
  "intranet",
  "public_web",
  "schoology",
  "google",
];

export const DELETE = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "content:publish_internal", requestId);
  if (scopeError) return scopeError;

  const log = createLogger({ requestId, route: "api.v1.content.unpublish" });

  const id = extractStringParam(request.url, "content");
  const destinationRaw = extractStringParam(request.url, "publish");
  if (!id) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Missing content id");
  }
  if (!destinationRaw || !DESTINATIONS.includes(destinationRaw as PublishDestination)) {
    return createErrorResponse(
      requestId,
      400,
      "VALIDATION_ERROR",
      "Invalid or missing destination"
    );
  }
  const destination = destinationRaw as PublishDestination;

  const resolved = await resolveRestRequester(auth, requestId);
  if ("response" in resolved) return resolved.response;
  const { req } = resolved;

  // Same authority key as publish/set_visibility/create: an EXPLICIT
  // content:publish_public scope, never a session's wildcard ["*"].
  const hasPublishPublicCapability = hasPublishPublicScope(auth.scopes);

  try {
    // Session humans must also hold the atrium-content capability (see helper).
    await assertContentAuthoringCapability(auth);
    const result = await publishService.unpublish(req, id, destination, {
      hasPublishPublicCapability,
    });
    void recordContentAudit({
      req,
      action: "unpublish",
      surface: "rest",
      objectId: id,
      destination,
      outcome: "ok",
      requestId,
    });
    log.info("Unpublished via REST", { objectId: id, destination, ...result });
    return createApiResponse({ data: { id, destination, ...result }, meta: { requestId } }, requestId);
  } catch (err) {
    if (err instanceof ApprovalRequiredError) {
      log.info("Public unpublish requires approval", { objectId: id, destination });
      return respondApprovalRequired(err, {
        req,
        action: "unpublish",
        objectId: id,
        destination,
        requestId,
      });
    }
    void recordContentAudit({
      req,
      action: "unpublish",
      surface: "rest",
      objectId: id,
      destination,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return contentErrorToResponse(err, requestId);
  }
});
