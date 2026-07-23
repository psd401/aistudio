import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserIdFromSession } from "@/actions/repositories/repository-permissions";
import {
  getContentPlatformConfig,
  initiateRepositoryUpload,
  isCanonicalRepositoryUploadActive,
  isCanonicalUploadContentType,
  RepositoryUploadQuotaExceededError,
  validateRepositoryUploadFile,
} from "@/lib/repositories/content-platform";
import {
  bindNexusRepositoryToConversation,
  discardNexusEphemeralRepository,
  getOrCreateNexusEphemeralRepository,
  nexusConversationBelongsToOwner,
} from "@/lib/nexus/ephemeral-repository-service";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { apiRateLimit } from "@/lib/rate-limit";

const initiateSchema = z.object({
  draftKey: z.string().uuid(),
  // Product attribution only. This shared staging endpoint is intentionally
  // available to authenticated users of Nexus and Assistant Architect; the
  // purpose value is never treated as an authorization claim. Product routes
  // independently enforce conversation ownership and assistant execution.
  purpose: z.enum(["nexus", "assistant-architect"]),
  conversationId: z.string().uuid().optional(),
  fileName: z.string().trim().min(1).max(500),
  contentType: z.string().trim().min(1).max(255),
  byteSize: z.number().int().positive(),
});

async function initiateTemporaryAttachment(
  request: Request
): Promise<Response> {
  const requestId = generateRequestId();
  const timer = startTimer("api.repositories.temporary-attachments.create");
  const log = createLogger({
    requestId,
    route: "api.repositories.temporary-attachments.create",
  });
  let compensation:
    | { ownerId: number; bindingId: string; repositoryId: number }
    | undefined;

  try {
    const session = await getServerSession();
    if (!session?.sub) {
      return NextResponse.json(
        { error: "Unauthorized", requestId },
        { status: 401 }
      );
    }

    const parsed = initiateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid temporary attachment request", requestId },
        { status: 400 }
      );
    }

    const config = await getContentPlatformConfig();
    if (
      !isCanonicalRepositoryUploadActive(config) ||
      !isCanonicalUploadContentType(parsed.data.contentType)
    ) {
      timer({ status: "success", mode: "legacy", purpose: parsed.data.purpose });
      return NextResponse.json({ mode: "legacy", requestId });
    }

    const ownerId = await getUserIdFromSession(session.sub);
    validateRepositoryUploadFile(
      {
        itemName: parsed.data.fileName,
        fileName: parsed.data.fileName,
        contentType: parsed.data.contentType,
        byteSize: parsed.data.byteSize,
      },
      config
    );
    if (
      parsed.data.conversationId &&
      !(await nexusConversationBelongsToOwner({
        ownerId,
        conversationId: parsed.data.conversationId,
      }))
    ) {
      timer({ status: "error" });
      return NextResponse.json(
        { error: "Temporary attachment upload failed", requestId },
        { status: 400 }
      );
    }

    const binding = await getOrCreateNexusEphemeralRepository({
      ownerId,
      draftKey: parsed.data.draftKey,
      policy: {
        nexusAttachmentRetentionDays: config.nexusAttachmentRetentionDays,
        deletionGraceDays: config.deletionGraceDays,
      },
    });
    if (binding.created) {
      compensation = {
        ownerId,
        bindingId: binding.bindingId,
        repositoryId: binding.repositoryId,
      };
    }
    if (parsed.data.conversationId) {
      await bindNexusRepositoryToConversation({
        ownerId,
        draftKey: parsed.data.draftKey,
        conversationId: parsed.data.conversationId,
      });
    }

    const upload = await initiateRepositoryUpload(
      {
        repositoryId: binding.repositoryId,
        userId: ownerId,
        itemName: parsed.data.fileName,
        fileName: parsed.data.fileName,
        contentType: parsed.data.contentType,
        byteSize: parsed.data.byteSize,
      },
      config
    );

    timer({
      status: "success",
      mode: "canonical",
      purpose: parsed.data.purpose,
      repositoryId: binding.repositoryId,
    });
    return NextResponse.json({
      mode: "canonical",
      bindingId: binding.bindingId,
      repositoryId: binding.repositoryId,
      upload,
      requestId,
    });
  } catch (error) {
    timer({ status: "error" });
    log.error("Temporary attachment upload failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    if (compensation) {
      try {
        await discardNexusEphemeralRepository(compensation);
      } catch (cleanupError) {
        log.error("Temporary attachment compensation failed", {
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : "Unknown error",
          repositoryId: compensation.repositoryId,
        });
      }
    }
    if (error instanceof RepositoryUploadQuotaExceededError) {
      return NextResponse.json(
        {
          error: "Temporary attachment upload quota exceeded",
          code: error.code,
          requestId,
        },
        { status: error.httpStatus }
      );
    }
    return NextResponse.json(
      {
        error: "Temporary attachment upload failed",
        requestId,
      },
      { status: 400 }
    );
  }
}

export const POST = apiRateLimit.upload(initiateTemporaryAttachment);
