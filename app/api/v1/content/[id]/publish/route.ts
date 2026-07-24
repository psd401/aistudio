/**
 * Atrium Content Publish Endpoint (Issue #1055, Phase 5 §23, §26.4)
 * POST /api/v1/content/:id/publish — publish to a destination
 *
 * Mirrors the MCP publish_content tool. Requires content:publish_internal; the
 * public-publish gate is enforced in publishService and surfaces here as a
 * structured 202 `approval_required` when the caller lacks content:publish_public.
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
  contentHeadEtag,
  hasPublishPublicScope,
  parseContentIfMatch,
  publishService,
  recordContentAudit,
  runIdempotentMutation,
} from "@/lib/content";
import {
  contentIdempotentMutationErrorToResponse,
  resolveRestRequester,
  respondApprovalRequired,
  restVisibilitySchema,
} from "@/lib/content/rest";
import { assertContentAuthoringCapability } from "@/lib/content/surface-helpers";
import { createLogger } from "@/lib/logger";

const publishBodySchema = z.object({
  // `okf` serializes the single object to a portable OKF concept bundle in S3
  // (Phase 8, #1103) — internal-publish authority, not a public destination.
  destination: z.enum(["intranet", "public_web", "schoology", "google", "okf"]),
  visibility: restVisibilitySchema.optional(),
});

export const POST = withApiAuth(async (request: NextRequest, auth, requestId, params) => {
  const scopeError = requireScope(auth, "content:publish_internal", requestId);
  if (scopeError) return scopeError;

  const log = createLogger({ requestId, route: "api.v1.content.publish" });

  // Real Next.js [id] route param — collision-free vs. parsing the URL by segment.
  const id = params.id;
  if (!id) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Missing content id");
  }

  const parsedBody = await parseRequestBody(request, publishBodySchema, requestId);
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

  // The public-publish gate keys off authority. For an API caller that is the
  // token's EXPLICIT content:publish_public scope. A session's wildcard ["*"]
  // must NOT auto-grant it (every logged-in human would otherwise bypass the
  // gate) — admin humans still pass via req.isAdmin inside the service.
  const hasPublishPublicCapability = hasPublishPublicScope(auth.scopes);

  return runIdempotentMutation(
    {
      request,
      auth,
      requestId,
      canonicalRoute: `/api/v1/content/${id}/publish`,
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
        const result = await publishService.publish(
          req,
          id,
          { destination: input.destination, visibility: input.visibility },
          {
            hasPublishPublicCapability,
            expectedVersionId: precondition.expectedVersionId,
          }
        );
        void recordContentAudit({
          req,
          action: "publish",
          surface: "rest",
          objectId: id,
          destination: input.destination,
          outcome: "ok",
          requestId,
        });
        log.info("Published via REST", {
          objectId: id,
          destination: input.destination,
        });
        const response = createApiResponse(
          {
            data: {
              id,
              destination: input.destination,
              publishedVersionId: result.publishedVersionId,
            },
            meta: { requestId },
          },
          requestId
        );
        response.headers.set(
          "ETag",
          contentHeadEtag(result.publishedVersionId)
        );
        return response;
      } catch (err) {
        // The §26.4 gate: an unauthorized public publish is not an error but a
        // structured approval signal (202) that drives the review queue.
        if (err instanceof ApprovalRequiredError) {
          log.info("Public publish requires approval", {
            objectId: id,
            destination: input.destination,
          });
          return respondApprovalRequired(err, {
            req,
            action: "publish",
            objectId: id,
            destination: input.destination,
            requestId,
          });
        }
        void recordContentAudit({
          req,
          action: "publish",
          surface: "rest",
          objectId: id,
          destination: input.destination,
          outcome: "error",
          error: err instanceof Error ? err.message : String(err),
          requestId,
        });
        return contentIdempotentMutationErrorToResponse(err, requestId);
      }
    }
  );
});
