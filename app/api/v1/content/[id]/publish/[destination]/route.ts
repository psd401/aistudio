/**
 * Atrium Content Unpublish Endpoint (Issue #1055, Phase 5 §23)
 * DELETE /api/v1/content/:id/publish/:destination — unpublish from a destination
 *
 * Idempotent: unpublishing an object that is not live at the destination returns
 * `unpublished: false` rather than erroring.
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
  publishService,
  recordContentAudit,
  requesterFromApiAuth,
} from "@/lib/content";
import { contentErrorToResponse } from "@/lib/content/rest";
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

  let req;
  try {
    req = await requesterFromApiAuth(auth);
  } catch (err) {
    return contentErrorToResponse(err, requestId);
  }

  try {
    const result = await publishService.unpublish(req, id, destination);
    await recordContentAudit({
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
    await recordContentAudit({
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
