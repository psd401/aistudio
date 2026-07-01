/**
 * Atrium REST v1 helpers (Issue #1055, Phase 5 §23)
 *
 * Shared by the `app/api/v1/content/*` routes: maps a thrown `ContentError` to
 * the v1 error envelope (so each surface stays 1:1 with the services), plus the
 * Zod fragments the route bodies reuse.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiResponse, createErrorResponse } from "@/lib/api/auth-middleware";
import { recordContentAudit, type ContentAuditAction } from "./audit";
import { ApprovalRequiredError, isContentError } from "./errors";
import {
  requesterFromApiAuth,
  type RequesterAuthInput,
} from "./requester-from-auth";
import type { PublishDestination } from "./publish-adapters/types";
import type { Requester } from "./types";

/** Map a thrown error to the v1 error envelope, honoring `ContentError.status`. */
export function contentErrorToResponse(
  err: unknown,
  requestId: string
): NextResponse {
  if (isContentError(err)) {
    return createErrorResponse(
      requestId,
      err.status,
      err.code,
      err.message,
      err.details
    );
  }
  return createErrorResponse(
    requestId,
    500,
    "INTERNAL_ERROR",
    err instanceof Error ? err.message : "Internal error"
  );
}

/**
 * Resolve a REST caller into a content `Requester`, or an error `Response`. The
 * mutating content routes share this instead of hand-rolling the same try/catch
 * (mirrors the MCP-side `resolveReq`). A resolution failure (e.g. a token for a
 * deleted user, or a deactivated agent) maps through `contentErrorToResponse` to
 * the v1 envelope (403/…), never a raw 500.
 */
export async function resolveRestRequester(
  auth: RequesterAuthInput,
  requestId: string
): Promise<{ req: Requester } | { response: NextResponse }> {
  try {
    return { req: await requesterFromApiAuth(auth) };
  } catch (err) {
    return { response: contentErrorToResponse(err, requestId) };
  }
}

/**
 * The §26.4 approval signal, single-sourced for every REST content route.
 *
 * A public-facing create/publish/visibility change by a caller lacking
 * `content:publish_public` is NOT an error but a structured **202
 * `approval_required`** that drives the review queue. Every REST route surfaces
 * it identically: record the `approval_required` audit row, then return the 202
 * envelope. Centralizing it here (rather than hand-rolling the same block in each
 * route) means the approval-response contract has ONE definition to change.
 */
export function respondApprovalRequired(
  err: ApprovalRequiredError,
  ctx: {
    req: Requester;
    action: ContentAuditAction;
    objectId?: string | null;
    destination?: PublishDestination;
    requestId: string;
  }
): NextResponse {
  // Best-effort audit, fire-and-forget: it swallows its own errors and must not
  // add a DB round-trip to the response (long-lived ECS process completes it).
  void recordContentAudit({
    req: ctx.req,
    action: ctx.action,
    surface: "rest",
    objectId: ctx.objectId ?? null,
    destination: ctx.destination,
    outcome: "approval_required",
    error: err.message,
    requestId: ctx.requestId,
  });
  return createApiResponse(
    {
      data: { status: "approval_required", message: err.message },
      meta: { requestId: ctx.requestId },
    },
    ctx.requestId,
    202
  );
}

export const restGrantSchema = z.object({
  kind: z.enum(["role", "building", "department", "grade", "user"]),
  value: z.string(),
});

export const restVisibilitySchema = z.object({
  level: z.enum(["private", "group", "internal", "public"]),
  grants: z.array(restGrantSchema).optional(),
});
