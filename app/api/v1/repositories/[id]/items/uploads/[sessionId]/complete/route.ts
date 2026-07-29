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
  completeRepositoryUpload,
  dispatchContentProcessingJob,
} from "@/lib/repositories/content-platform";

const completeSchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            ETag: z.string().min(1).max(512),
            PartNumber: z.number().int().positive().max(10_000),
          })
          .strict(),
      )
      .max(10_000)
      .optional(),
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
    const sessionId = z.string().uuid().safeParse(params.sessionId);
    if (
      !Number.isSafeInteger(repositoryId) ||
      repositoryId <= 0 ||
      !sessionId.success
    ) {
      return createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Invalid upload path",
      );
    }

    const parsed = await parseRequestBody(request, completeSchema, requestId);
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
      route: "api.v1.repositories.items.uploads.complete",
    });

    try {
      const completed = await completeRepositoryUpload({
        repositoryId,
        userId: auth.userId,
        sessionId: sessionId.data,
        parts: parsed.data.parts,
      });
      try {
        await dispatchContentProcessingJob({
          jobId: completed.processingJobId,
          itemVersionId: completed.itemVersionId,
        });
      } catch (dispatchError) {
        // The processing job is a durable outbox. Scheduled dispatch retries
        // this job, so the committed upload remains successful.
        log.warn("Repository upload is pending scheduled dispatch", {
          processingJobId: completed.processingJobId,
          error:
            dispatchError instanceof Error
              ? dispatchError.message
              : String(dispatchError),
        });
      }

      log.info("Completed repository upload via API", {
        userId: auth.userId,
        repositoryId,
        sessionId: sessionId.data,
        itemId: completed.itemId,
        replayed: completed.replayed,
      });
      const response = createApiResponse(
        { data: completed, meta: { requestId } },
        requestId,
      );
      if (completed.replayed) {
        response.headers.set("Idempotency-Replayed", "true");
      }
      return response;
    } catch (error) {
      log.error("Failed to complete repository upload via API", {
        userId: auth.userId,
        repositoryId,
        sessionId: sessionId.data,
        error: error instanceof Error ? error.message : String(error),
      });
      return createErrorResponse(
        requestId,
        400,
        "UPLOAD_COMPLETION_FAILED",
        "Failed to complete repository upload",
      );
    }
  },
);
