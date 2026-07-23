import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserIdFromSession } from "@/actions/repositories/repository-permissions";
import {
  promoteNexusRepository,
  resolveNexusAttachmentForPromotion,
} from "@/lib/nexus/ephemeral-repository-service";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { hasCapabilityAccess } from "@/utils/roles";

const pathSchema = z.object({
  bindingId: z.string().uuid(),
  itemId: z.coerce.number().int().positive().safe(),
});
const bodySchema = z.object({
  name: z.string().trim().min(1).max(500),
});

export async function POST(
  request: Request,
  context: {
    params: Promise<{ bindingId: string; itemId: string }>;
  }
): Promise<Response> {
  const requestId = generateRequestId();
  const timer = startTimer("api.repositories.temporary-attachments.promote");
  const log = createLogger({
    requestId,
    route: "api.repositories.temporary-attachments.promote",
  });

  try {
    const session = await getServerSession();
    if (!session?.sub) {
      return NextResponse.json(
        { error: "Unauthorized", requestId },
        { status: 401 }
      );
    }
    if (!(await hasCapabilityAccess("knowledge-repositories", session.sub))) {
      timer({ status: "denied", reason: "missing_capability" });
      return NextResponse.json(
        { error: "Forbidden", requestId },
        { status: 403 }
      );
    }
    const [path, body] = await Promise.all([
      context.params.then((params) => pathSchema.safeParse(params)),
      request.json().then((value: unknown) => bodySchema.safeParse(value)),
    ]);
    if (!path.success || !body.success) {
      return NextResponse.json(
        { error: "Attachment not found", requestId },
        { status: 404 }
      );
    }

    const ownerId = await getUserIdFromSession(session.sub);
    const reference = await resolveNexusAttachmentForPromotion({
      ownerId,
      bindingId: path.data.bindingId,
      itemId: path.data.itemId,
    });
    if (!reference) {
      return NextResponse.json(
        { error: "Attachment not found", requestId },
        { status: 404 }
      );
    }
    const repository = await promoteNexusRepository({
      ownerId,
      repositoryId: reference.repositoryId,
      name: body.data.name,
    });
    timer({ status: "success", repositoryId: repository.repositoryId });
    return NextResponse.json({
      repositoryId: repository.repositoryId,
      name: body.data.name,
      requestId,
    });
  } catch (error) {
    timer({ status: "error" });
    log.warn("Temporary attachment promotion rejected", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      { error: "Attachment not found", requestId },
      { status: 404 }
    );
  }
}
