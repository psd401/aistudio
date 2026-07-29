import { NextRequest } from "next/server";
import { z } from "zod";
import {
  createApiResponse,
  createErrorResponse,
  parseRequestBody,
  requireScope,
  withApiAuth,
} from "@/lib/api";
import { canModifyRepository } from "@/actions/repositories/repository-permissions";
import { createLogger } from "@/lib/logger";
import { assertNotSystemManagedRepository } from "@/lib/repositories/repository-access-guard";
import {
  getContentPlatformConfig,
  initiateRepositoryUpload,
  isCanonicalRepositoryUploadActive,
  RepositoryUploadQuotaExceededError,
  validateRepositoryUploadFile,
} from "@/lib/repositories/content-platform";

const initiateSchema = z
  .object({
    itemName: z.string().trim().min(1).max(500),
    fileName: z.string().trim().min(1).max(500),
    contentType: z.string().trim().min(1).max(255),
    byteSize: z.number().int().positive(),
  })
  .strict();

async function callerCanManageRepository(
  repositoryId: number,
  userId: number,
): Promise<boolean> {
  try {
    await assertNotSystemManagedRepository(repositoryId);
    return await canModifyRepository(repositoryId, userId);
  } catch {
    return false;
  }
}

export const POST = withApiAuth(
  async (request: NextRequest, auth, requestId, params) => {
    const scopeError = requireScope(auth, "repositories:write", requestId);
    if (scopeError) return scopeError;

    const repositoryId = Number(params.id);
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      return createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Invalid repository id",
      );
    }

    const parsed = await parseRequestBody(request, initiateSchema, requestId);
    if (parsed instanceof Response) return parsed;

    if (!(await callerCanManageRepository(repositoryId, auth.userId))) {
      return createErrorResponse(
        requestId,
        404,
        "NOT_FOUND",
        "Repository not found",
      );
    }

    const log = createLogger({
      requestId,
      route: "api.v1.repositories.items.uploads.initiate",
    });

    try {
      const config = await getContentPlatformConfig();
      if (!isCanonicalRepositoryUploadActive(config)) {
        return createErrorResponse(
          requestId,
          503,
          "UPLOAD_UNAVAILABLE",
          "Canonical repository uploads are not available",
        );
      }

      try {
        validateRepositoryUploadFile(parsed.data, config);
      } catch (error) {
        return createErrorResponse(
          requestId,
          400,
          "VALIDATION_ERROR",
          error instanceof Error ? error.message : "Invalid upload request",
        );
      }

      const upload = await initiateRepositoryUpload(
        {
          repositoryId,
          userId: auth.userId,
          ...parsed.data,
        },
        config,
      );
      log.info("Initiated repository upload via API", {
        userId: auth.userId,
        repositoryId,
        sessionId: upload.sessionId,
        uploadMethod: upload.uploadMethod,
      });
      return createApiResponse(
        { data: upload, meta: { requestId } },
        requestId,
        201,
      );
    } catch (error) {
      if (error instanceof RepositoryUploadQuotaExceededError) {
        return createErrorResponse(
          requestId,
          error.httpStatus,
          error.code,
          "Repository upload quota exceeded",
        );
      }
      log.error("Failed to initiate repository upload via API", {
        userId: auth.userId,
        repositoryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return createErrorResponse(
        requestId,
        500,
        "INTERNAL_ERROR",
        "Failed to initiate repository upload",
      );
    }
  },
);
