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
  parseRequestBody,
} from "@/lib/api";
import { z } from "zod";
import {
  contentService,
  contentHeadEtag,
  parseContentIfMatch,
  runIdempotentMutation,
  versionService,
  recordContentAudit,
  requesterFromApiAuth,
} from "@/lib/content";
import {
  contentErrorToResponse,
  contentIdempotentMutationErrorToResponse,
  resolveRestRequester,
} from "@/lib/content/rest";
import { assertContentAuthoringCapability } from "@/lib/content/surface-helpers";
import { decodeContentBody } from "@/lib/content/code-encoding";
import { createLogger } from "@/lib/logger";

const createVersionBodySchema = z.object({
  body: z.string().min(1),
  bodyFormat: z.enum(["markdown", "html", "jsx"]).optional(),
  // Send `"base64"` so artifact code with <script>/<style> is opaque to the ALB
  // WAF; the server decodes before §28.3 screening / size caps. Omit for raw text.
  codeEncoding: z.enum(["base64"]).optional(),
  summary: z.string().max(2000).optional(),
});

// ============================================
// GET — list versions
// ============================================

export const GET = withApiAuth(async (request: NextRequest, auth, requestId, params) => {
  const scopeError = requireScope(auth, "content:read", requestId);
  if (scopeError) return scopeError;

  // Real Next.js [id] route param — collision-free vs. parsing the URL by segment.
  const id = params.id;
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

export const POST = withApiAuth(
  async (request: NextRequest, auth, requestId, params) => {
    const scopeError = requireScope(auth, "content:update", requestId);
    if (scopeError) return scopeError;

    const log = createLogger({
      requestId,
      route: "api.v1.content.createVersion",
    });

    const id = params.id;
    if (!id) {
      return createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Missing content id"
      );
    }

    const parsedBody = await parseRequestBody(
      request,
      createVersionBodySchema,
      requestId
    );
    if (parsedBody instanceof Response) return parsedBody;
    const input = parsedBody.data;
    const precondition = parseContentIfMatch(request.headers.get("if-match"));
    if (!precondition.ok) {
      return createErrorResponse(
        requestId,
        400,
        "INVALID_IF_MATCH",
        'If-Match must be a single strong ETag containing a version id or "none"'
      );
    }

    const resolved = await resolveRestRequester(auth, requestId);
    if ("response" in resolved) return resolved.response;
    const { req } = resolved;

    return runIdempotentMutation(
      {
        request,
        auth,
        requestId,
        canonicalRoute: `/api/v1/content/${id}/versions`,
        requestValue: {
          body: input,
          ifMatch:
            precondition.expectedVersionId ??
            (precondition.expectedVersionId === null ? "none" : undefined),
        },
      },
      async () => {
        try {
          // Session humans must also hold the atrium-content capability.
          await assertContentAuthoringCapability(auth);
          // Decode before the service screens and size-caps the body.
          const body =
            decodeContentBody(input.body, input.codeEncoding) ?? input.body;
          const result = await contentService.createVersion(
            req,
            id,
            {
              body,
              bodyFormat: input.bodyFormat,
              summary: input.summary,
            },
            { expectedVersionId: precondition.expectedVersionId }
          );
          void recordContentAudit({
            req,
            action: "create_version",
            surface: "rest",
            objectId: id,
            outcome: "ok",
            requestId,
          });
          log.info("Created version via REST", {
            objectId: id,
            versionId: result.version?.id,
          });
          const response = createApiResponse(
            { data: result, meta: { requestId } },
            requestId,
            201
          );
          response.headers.set("ETag", contentHeadEtag(result.currentVersionId));
          return response;
        } catch (err) {
          void recordContentAudit({
            req,
            action: "create_version",
            surface: "rest",
            objectId: id,
            outcome: "error",
            error: err instanceof Error ? err.message : String(err),
            requestId,
          });
          return contentIdempotentMutationErrorToResponse(err, requestId);
        }
      }
    );
  }
);
