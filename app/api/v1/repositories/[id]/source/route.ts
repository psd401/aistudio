import { NextRequest } from "next/server";
import { z } from "zod";
import {
  createApiResponse,
  createErrorResponse,
  requireScope,
  withApiAuth,
} from "@/lib/api";
import { getRepositorySource } from "@/lib/repositories/repository-catalog-service";

const querySchema = z.object({
  itemId: z.coerce.number().int().positive(),
  chunkId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const GET = withApiAuth(
  async (request: NextRequest, auth, requestId, params) => {
    const scopeError = requireScope(auth, "repositories:read", requestId);
    if (scopeError) return scopeError;
    const repositoryId = Number(params.id);
    const query = querySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries())
    );
    if (
      !Number.isSafeInteger(repositoryId) ||
      repositoryId <= 0 ||
      !query.success
    ) {
      return createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "A valid repository id and itemId are required",
        query.success ? undefined : query.error.issues
      );
    }
    const segments = await getRepositorySource({
      userId: auth.userId,
      repositoryId,
      ...query.data,
    });
    if (segments.length === 0) {
      return createErrorResponse(
        requestId,
        404,
        "NOT_FOUND",
        "Repository source not found"
      );
    }
    return createApiResponse(
      { data: segments, meta: { requestId, count: segments.length } },
      requestId
    );
  }
);
