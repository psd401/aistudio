import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "@/lib/auth/server-session";
import { hasCapabilityAccess } from "@/utils/roles";
import {
  canModifyRepository,
  getUserIdFromSession,
} from "@/actions/repositories/repository-permissions";
import { assertNotSystemManagedRepository } from "@/lib/repositories/repository-access-guard";
import {
  completeRepositoryUpload,
  dispatchContentProcessingJob,
} from "@/lib/repositories/content-platform";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";

const completeSchema = z.object({
  parts: z
    .array(
      z.object({
        ETag: z.string().min(1).max(512),
        PartNumber: z.number().int().positive().max(10_000),
      })
    )
    .max(10_000)
    .optional(),
});

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{ repositoryId: string; sessionId: string }>;
  }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.repositories.uploads.complete");
  const log = createLogger({
    requestId,
    route: "api.repositories.uploads.complete",
  });

  try {
    const session = await getServerSession();
    if (!session?.sub) {
      return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
    }
    if (!(await hasCapabilityAccess("knowledge-repositories"))) {
      return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
    }

    const params = await context.params;
    const repositoryId = Number(params.repositoryId);
    const sessionId = z.string().uuid().safeParse(params.sessionId);
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !sessionId.success) {
      return NextResponse.json(
        { error: "Invalid upload path", requestId },
        { status: 400 }
      );
    }
    const parsed = completeSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid multipart completion", requestId },
        { status: 400 }
      );
    }

    const userId = await getUserIdFromSession(session.sub);
    await assertNotSystemManagedRepository(repositoryId);
    if (!(await canModifyRepository(repositoryId, userId))) {
      return NextResponse.json({ error: "Not found", requestId }, { status: 404 });
    }

    const completed = await completeRepositoryUpload({
      repositoryId,
      userId,
      sessionId: sessionId.data,
      parts: parsed.data.parts,
    });
    try {
      await dispatchContentProcessingJob({
        jobId: completed.processingJobId,
        itemVersionId: completed.itemVersionId,
      });
    } catch (dispatchError) {
      // The DB job is the durable outbox. A scheduled dispatcher retries it;
      // upload completion must not be rolled back after S3 has committed.
      log.warn("Canonical upload is pending scheduled dispatch", {
        processingJobId: completed.processingJobId,
        error:
          dispatchError instanceof Error ? dispatchError.message : "Unknown error",
      });
    }
    timer({ status: "success", replayed: completed.replayed });
    return NextResponse.json({ completed, requestId });
  } catch (error) {
    timer({ status: "error" });
    log.error("Failed to complete canonical repository upload", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to complete upload",
        requestId,
      },
      { status: 400 }
    );
  }
}
