/**
 * Atrium OKF Export Endpoint (Issue #1103, Phase 8 §36.4)
 * POST /api/v1/content/export/okf — export a collection subtree as an OKF bundle
 *
 * Mirrors the MCP `export_okf` tool. Requires `content:read` (export is a
 * read/serialization; every object is `canView`-filtered in the service). An
 * `audience: "public"` bundle is gated by §26.4 and surfaces here as a structured
 * 202 `approval_required` when the caller lacks `content:publish_public`.
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
  hasPublishPublicScope,
  okfExportService,
  recordContentAudit,
} from "@/lib/content";
import {
  contentErrorToResponse,
  resolveRestRequester,
  respondApprovalRequired,
} from "@/lib/content/rest";
import { resolveCollectionId } from "@/lib/content/surface-helpers";
import { createLogger } from "@/lib/logger";

const exportBodySchema = z.object({
  collectionId: z.string().min(1).max(200),
  audience: z.enum(["internal", "public"]).optional(),
});

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "content:read", requestId);
  if (scopeError) return scopeError;

  const log = createLogger({ requestId, route: "api.v1.content.export.okf" });

  const parsedBody = await parseRequestBody(request, exportBodySchema, requestId);
  if (parsedBody instanceof Response) return parsedBody;
  const input = parsedBody.data;

  const resolved = await resolveRestRequester(auth, requestId);
  if ("response" in resolved) return resolved.response;
  const { req } = resolved;

  // The §26.4 public-bundle gate keys off authority: an EXPLICIT
  // content:publish_public scope (never a session wildcard ["*"] — admins still
  // pass via req.isAdmin inside the service).
  const hasPublishPublicCapability = hasPublishPublicScope(auth.scopes);

  try {
    // `resolveCollectionId` THROWS `ValidationError` (400 CONTENT_VALIDATION) for an
    // unresolvable slug/id — caught below and mapped to a 400, consistent with every
    // other content route. This guard only handles the impossible empty-input case
    // (zod `.min(1)` already rejects it), so it too returns a 400, never a 404.
    const collectionId = await resolveCollectionId(input.collectionId);
    if (!collectionId) {
      return createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Collection not found"
      );
    }
    const result = await okfExportService.exportCollection(req, collectionId, {
      audience: input.audience,
      hasPublishPublicCapability,
    });
    void recordContentAudit({
      req,
      action: "export_okf",
      surface: "rest",
      objectId: null,
      destination: "okf",
      outcome: "ok",
      requestId,
    });
    log.info("Exported OKF bundle via REST", {
      rootCollectionId: result.bundle.rootCollectionId,
      audience: result.bundle.audience,
      objectCount: result.bundle.objectCount,
    });
    return createApiResponse(
      {
        data: {
          okfVersion: result.bundle.okfVersion,
          generator: result.bundle.generator,
          rootCollectionId: result.bundle.rootCollectionId,
          audience: result.bundle.audience,
          objectCount: result.bundle.objectCount,
          collectionCount: result.bundle.collectionCount,
          files: result.bundle.files,
          location: result.url,
        },
        meta: { requestId },
      },
      requestId
    );
  } catch (err) {
    // §26.4 — an unauthorized public export is a structured 202 approval signal.
    if (err instanceof ApprovalRequiredError) {
      log.info("Public OKF export requires approval", {
        collectionId: input.collectionId,
      });
      return respondApprovalRequired(err, {
        req,
        action: "export_okf",
        destination: "okf",
        requestId,
      });
    }
    void recordContentAudit({
      req,
      action: "export_okf",
      surface: "rest",
      objectId: null,
      destination: "okf",
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return contentErrorToResponse(err, requestId);
  }
});
