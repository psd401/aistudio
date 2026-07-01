/**
 * Atrium Content Versions Endpoint (Issue #1055, Phase 5 §23)
 * GET  /api/v1/content/:id/versions — list versions (newest first)
 * POST /api/v1/content/:id/versions — create a new version (body + summary)
 *
 * Mirrors the MCP create_version tool plus version listing.
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
  versionService,
  recordContentAudit,
  requesterFromApiAuth,
} from "@/lib/content";
import { contentErrorToResponse } from "@/lib/content/rest";
import { assertContentAuthoringCapability } from "@/lib/content/surface-helpers";
import { createLogger } from "@/lib/logger";

const createVersionBodySchema = z.object({
  body: z.string().min(1),
  bodyFormat: z.enum(["markdown", "html", "jsx"]).optional(),
  summary: z.string().max(2000).optional(),
});

// ============================================
// GET — list versions
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
    // get() enforces canView (404-masks); only then expose the version list.
    const obj = await contentService.get(req, id);
    const versions = await versionService.list(obj.id);
    return createApiResponse(
      { data: versions, meta: { requestId, count: versions.length } },
      requestId
    );
  } catch (err) {
    return contentErrorToResponse(err, requestId);
  }
});

// ============================================
// POST — create a new version
// ============================================

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "content:update", requestId);
  if (scopeError) return scopeError;

  const log = createLogger({ requestId, route: "api.v1.content.createVersion" });

  const id = extractStringParam(request.url, "content");
  if (!id) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Missing content id");
  }

  const parsedBody = await parseRequestBody(request, createVersionBodySchema, requestId);
  if (parsedBody instanceof Response) return parsedBody;
  const input = parsedBody.data;

  let req;
  try {
    req = await requesterFromApiAuth(auth);
  } catch (err) {
    return contentErrorToResponse(err, requestId);
  }

  try {
    // Session humans must also hold the atrium-content capability (see helper).
    await assertContentAuthoringCapability(auth);
    const result = await contentService.createVersion(req, id, {
      body: input.body,
      bodyFormat: input.bodyFormat,
      summary: input.summary,
    });
    await recordContentAudit({
      req,
      action: "create_version",
      surface: "rest",
      objectId: id,
      outcome: "ok",
      requestId,
    });
    log.info("Created version via REST", { objectId: id, versionId: result.version?.id });
    return createApiResponse({ data: result, meta: { requestId } }, requestId, 201);
  } catch (err) {
    await recordContentAudit({
      req,
      action: "create_version",
      surface: "rest",
      objectId: id,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return contentErrorToResponse(err, requestId);
  }
});
