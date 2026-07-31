import { NextRequest } from "next/server";
import { z } from "zod";
import {
  createApiResponse,
  createErrorResponse,
  parseRequestBody,
  requireScope,
  withApiAuth,
} from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { searchRepositoryCatalog } from "@/lib/repositories/repository-catalog-service";
import { RepositoryReadinessError } from "@/lib/repositories/readiness-service";

const bodySchema = z.object({
  query: z.string().trim().min(1).max(2000),
  repositoryIds: z.array(z.number().int().positive()).max(50).optional(),
  mode: z.enum(["keyword", "vector", "hybrid"]).optional(),
  modalities: z
    .array(z.enum(["text", "image", "audio", "video", "table"]))
    .max(5)
    .optional(),
  limit: z.number().int().min(1).max(50).optional(),
  threshold: z.number().min(0).max(1).optional(),
});

export const POST = withApiAuth(
  async (request: NextRequest, auth, requestId) => {
    const scopeError = requireScope(auth, "repositories:search", requestId);
    if (scopeError) return scopeError;
    const parsed = await parseRequestBody(request, bodySchema, requestId);
    if (parsed instanceof Response) return parsed;
    const log = createLogger({
      requestId,
      route: "api.v1.repositories.search",
    });
    try {
      const result = await searchRepositoryCatalog({
        cognitoSub: auth.cognitoSub,
        ...parsed.data,
      });
      log.info("Searched repository catalog", {
        userId: auth.userId,
        requestedRepositoryCount: parsed.data.repositoryIds?.length ?? 0,
        returnedResults: result.results.length,
      });
      return createApiResponse(
        { data: result.results, meta: { requestId, ...result.diagnostics } },
        requestId
      );
    } catch (error) {
      if (error instanceof RepositoryReadinessError) {
        log.warn("Repository search rejected by readiness preflight", {
          code: error.code,
          repositoryCount: error.repositories.length,
        });
        return createErrorResponse(
          requestId,
          error.code === "REPOSITORY_BINDING_INACCESSIBLE" ? 403 : 409,
          error.code,
          error.message,
          { repositories: error.repositories }
        );
      }
      log.error("Failed to search repository catalog", {
        error: error instanceof Error ? error.message : String(error),
      });
      return createErrorResponse(
        requestId,
        500,
        "INTERNAL_ERROR",
        "Failed to search repositories"
      );
    }
  }
);
