import { NextRequest } from "next/server";
import { z } from "zod";
import {
  createApiResponse,
  createErrorResponse,
  requireScope,
  withApiAuth,
} from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { listRepositoryChanges } from "@/lib/repositories/repository-catalog-service";

const querySchema = z.object({
  repositoryIds: z
    .string()
    .min(1)
    .transform((value) => value.split(",").map(Number))
    .pipe(z.array(z.number().int().positive()).min(1).max(50)),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const GET = withApiAuth(
  async (request: NextRequest, auth, requestId) => {
    const scopeError = requireScope(auth, "repositories:changes", requestId);
    if (scopeError) return scopeError;
    const parsed = querySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries())
    );
    if (!parsed.success) {
      return createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Invalid repository changes query",
        parsed.error.issues
      );
    }
    const log = createLogger({
      requestId,
      route: "api.v1.repositories.changes",
    });
    try {
      const result = await listRepositoryChanges({
        userId: auth.userId,
        ...parsed.data,
      });
      return createApiResponse(
        {
          data: result.changes,
          meta: { requestId, nextCursor: result.nextCursor },
        },
        requestId
      );
    } catch (error) {
      const invalidCursor =
        error instanceof Error &&
        error.message === "Invalid repository changes cursor";
      if (!invalidCursor) {
        log.error("Failed to list repository changes", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return createErrorResponse(
        requestId,
        invalidCursor ? 400 : 500,
        invalidCursor ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
        invalidCursor
          ? "Invalid repository changes cursor"
          : "Failed to list repository changes"
      );
    }
  }
);
