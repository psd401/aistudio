import { NextRequest } from "next/server";
import { z } from "zod";
import {
  createApiResponse,
  createErrorResponse,
  requireScope,
  withApiAuth,
} from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { listRepositoryCatalog } from "@/lib/repositories/repository-catalog-service";

const querySchema = z.object({
  query: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const GET = withApiAuth(
  async (request: NextRequest, auth, requestId) => {
    const scopeError = requireScope(auth, "repositories:list", requestId);
    if (scopeError) return scopeError;
    const parsed = querySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries())
    );
    if (!parsed.success) {
      return createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Invalid repository query parameters",
        parsed.error.issues
      );
    }
    const log = createLogger({
      requestId,
      route: "api.v1.repositories.list",
    });
    try {
      const repositories = await listRepositoryCatalog(auth.cognitoSub, parsed.data);
      log.info("Listed repository catalog", {
        userId: auth.userId,
        count: repositories.length,
      });
      return createApiResponse(
        {
          data: repositories,
          meta: { requestId, count: repositories.length },
        },
        requestId
      );
    } catch (error) {
      log.error("Failed to list repository catalog", {
        error: error instanceof Error ? error.message : String(error),
      });
      return createErrorResponse(
        requestId,
        500,
        "INTERNAL_ERROR",
        "Failed to list repositories"
      );
    }
  }
);
