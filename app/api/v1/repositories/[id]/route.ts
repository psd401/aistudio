import { NextRequest } from "next/server";
import {
  createApiResponse,
  createErrorResponse,
  requireScope,
  withApiAuth,
} from "@/lib/api";
import { describeRepository } from "@/lib/repositories/repository-catalog-service";

export const GET = withApiAuth(
  async (
    _request: NextRequest,
    auth,
    requestId,
    params
  ) => {
    const scopeError = requireScope(auth, "repositories:list", requestId);
    if (scopeError) return scopeError;
    const repositoryId = Number(params.id);
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      return createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Invalid repository id"
      );
    }
    const repository = await describeRepository(auth.cognitoSub, repositoryId);
    if (!repository) {
      return createErrorResponse(
        requestId,
        404,
        "NOT_FOUND",
        "Repository not found"
      );
    }
    return createApiResponse(
      { data: repository, meta: { requestId } },
      requestId
    );
  }
);
