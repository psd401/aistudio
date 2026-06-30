/**
 * Atrium REST v1 helpers (Issue #1055, Phase 5 §23)
 *
 * Shared by the `app/api/v1/content/*` routes: maps a thrown `ContentError` to
 * the v1 error envelope (so each surface stays 1:1 with the services), plus the
 * Zod fragments the route bodies reuse.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createErrorResponse } from "@/lib/api/auth-middleware";
import { isContentError } from "./errors";

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

export const restGrantSchema = z.object({
  kind: z.enum(["role", "building", "department", "grade", "user"]),
  value: z.string(),
});

export const restVisibilitySchema = z.object({
  level: z.enum(["private", "group", "internal", "public"]),
  grants: z.array(restGrantSchema).optional(),
});
