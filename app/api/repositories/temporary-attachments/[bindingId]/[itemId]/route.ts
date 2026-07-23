import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserIdFromSession } from "@/actions/repositories/repository-permissions";
import { resolveNexusAttachmentReference } from "@/lib/nexus/ephemeral-repository-service";
import { getCanonicalRepositoryItemStatuses } from "@/lib/repositories/content-platform";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";

const pathSchema = z.object({
  bindingId: z.string().uuid(),
  itemId: z.coerce.number().int().positive().safe(),
});

export async function GET(
  _request: Request,
  context: {
    params: Promise<{ bindingId: string; itemId: string }>;
  }
): Promise<Response> {
  const requestId = generateRequestId();
  const timer = startTimer("api.repositories.temporary-attachments.status");
  const log = createLogger({
    requestId,
    route: "api.repositories.temporary-attachments.status",
  });

  try {
    const session = await getServerSession();
    if (!session?.sub) {
      return NextResponse.json(
        { error: "Unauthorized", requestId },
        { status: 401 }
      );
    }
    const path = pathSchema.safeParse(await context.params);
    if (!path.success) {
      return NextResponse.json(
        { error: "Attachment not found", requestId },
        { status: 404 }
      );
    }

    const ownerId = await getUserIdFromSession(session.sub);
    const attachment = await resolveNexusAttachmentReference({
      ownerId,
      bindingId: path.data.bindingId,
      itemId: path.data.itemId,
    });
    if (!attachment) {
      return NextResponse.json(
        { error: "Attachment not found", requestId },
        { status: 404 }
      );
    }

    const canonicalStatuses = await getCanonicalRepositoryItemStatuses(
      attachment.repositoryId
    );
    const canonicalStatus = canonicalStatuses.get(attachment.itemId);
    if (!canonicalStatus) {
      return NextResponse.json(
        { error: "Attachment not found", requestId },
        { status: 404 }
      );
    }
    timer({
      status: "success",
      processingStatus: canonicalStatus.processingStatus,
    });
    return NextResponse.json({
      status: canonicalStatus.processingStatus,
      error: canonicalStatus.processingError,
      requestId,
    });
  } catch (error) {
    timer({ status: "error" });
    log.error("Temporary attachment status failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      { error: "Attachment not found", requestId },
      { status: 404 }
    );
  }
}
