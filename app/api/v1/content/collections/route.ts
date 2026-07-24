/**
 * Permission-filtered Atrium collection discovery for external authoring clients
 * (#1286). This is a read-only picker surface; collection administration remains
 * on the existing internal UI.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import {
  createApiResponse,
  createErrorResponse,
  requireScope,
  withApiAuth,
} from "@/lib/api";
import { hasScope } from "@/lib/api-keys/key-service";
import { collectionService, requesterFromApiAuth } from "@/lib/content";
import { contentErrorToResponse } from "@/lib/content/rest";

const querySchema = z.object({
  shape: z.enum(["tree", "flat"]).default("tree"),
});

export const GET = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "content:read", requestId);
  if (scopeError) return scopeError;

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries())
  );
  if (!parsed.success) {
    return createErrorResponse(
      requestId,
      400,
      "VALIDATION_ERROR",
      "Invalid collection query parameters",
      parsed.error.issues
    );
  }

  try {
    const req = await requesterFromApiAuth(auth);
    const data = await collectionService.discover(req, {
      shape: parsed.data.shape,
      includeCreateSelection: hasScope(auth.scopes, "content:create"),
    });
    return createApiResponse(
      {
        data,
        meta: {
          requestId,
          shape: parsed.data.shape,
          count: data.length,
        },
      },
      requestId
    );
  } catch (error) {
    return contentErrorToResponse(error, requestId);
  }
});
