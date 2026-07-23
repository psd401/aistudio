import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserIdFromSession } from "@/actions/repositories/repository-permissions";
import {
  completeRepositoryUpload,
  dispatchContentProcessingJob,
} from "@/lib/repositories/content-platform";
import {
  resolveNexusAttachmentReference,
  resolveNexusRepositoryBinding,
} from "@/lib/nexus/ephemeral-repository-service";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { apiRateLimit } from "@/lib/rate-limit";

const completeSchema = z.object({
  sessionId: z.string().uuid(),
  // Accepted for compatibility with already-loaded clients, but never trusted
  // for provenance. The response name comes from repository_items.
  name: z.string().trim().min(1).max(500).optional(),
  parts: z
    .array(
      z.object({
        ETag: z.string().min(1).max(512),
        PartNumber: z.number().int().positive().max(100),
      })
    )
    .max(100)
    .optional(),
});

async function completeTemporaryAttachment(
  request: Request,
  context: { params: Promise<{ bindingId: string }> }
): Promise<Response> {
  const requestId = generateRequestId();
  const timer = startTimer("api.repositories.temporary-attachments.complete");
  const log = createLogger({
    requestId,
    route: "api.repositories.temporary-attachments.complete",
  });

  try {
    const session = await getServerSession();
    if (!session?.sub) {
      return NextResponse.json(
        { error: "Unauthorized", requestId },
        { status: 401 }
      );
    }
    const parsed = completeSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid temporary attachment completion", requestId },
        { status: 400 }
      );
    }

    const ownerId = await getUserIdFromSession(session.sub);
    const { bindingId } = await context.params;
    const binding = await resolveNexusRepositoryBinding({
      ownerId,
      bindingId,
    });
    if (!binding) {
      return NextResponse.json(
        { error: "Attachment not found", requestId },
        { status: 404 }
      );
    }

    const completed = await completeRepositoryUpload({
      repositoryId: binding.repositoryId,
      userId: ownerId,
      sessionId: parsed.data.sessionId,
      parts: parsed.data.parts,
    });
    try {
      await dispatchContentProcessingJob({
        jobId: completed.processingJobId,
        itemVersionId: completed.itemVersionId,
      });
    } catch (dispatchError) {
      // The processing row is a durable outbox and scheduled recovery retries
      // dispatch. Never invalidate an object that has already completed.
      log.warn("Temporary attachment is pending scheduled dispatch", {
        processingJobId: completed.processingJobId,
        error:
          dispatchError instanceof Error
            ? dispatchError.message
            : "Unknown error",
      });
    }
    const canonicalAttachment = await resolveNexusAttachmentReference({
      ownerId,
      bindingId: binding.bindingId,
      itemId: completed.itemId,
    });
    if (!canonicalAttachment) {
      throw new Error("Completed attachment could not be resolved");
    }

    timer({
      status: "success",
      repositoryId: binding.repositoryId,
      itemId: completed.itemId,
      replayed: completed.replayed,
    });
    return NextResponse.json({
      mode: "canonical",
      reference: {
        bindingId: binding.bindingId,
        itemId: completed.itemId,
        name: canonicalAttachment.itemName,
      },
      repositoryId: binding.repositoryId,
      itemVersionId: completed.itemVersionId,
      processingJobId: completed.processingJobId,
      requestId,
    });
  } catch (error) {
    timer({ status: "error" });
    log.error("Temporary attachment completion failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      { error: "Temporary attachment completion failed", requestId },
      { status: 400 }
    );
  }
}

export const POST = apiRateLimit.upload(completeTemporaryAttachment);
