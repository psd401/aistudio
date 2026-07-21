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
  getContentPlatformConfig,
  initiateRepositoryUpload,
  isCanonicalRepositoryUploadActive,
} from "@/lib/repositories/content-platform";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";

const initiateSchema = z.object({
  itemName: z.string().trim().min(1).max(500),
  fileName: z.string().trim().min(1).max(500),
  contentType: z.string().min(1).max(255),
  byteSize: z.number().int().positive(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ repositoryId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("api.repositories.uploads.initiate");
  const log = createLogger({
    requestId,
    route: "api.repositories.uploads.initiate",
  });

  try {
    const session = await getServerSession();
    if (!session?.sub) {
      return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
    }
    if (!(await hasCapabilityAccess("knowledge-repositories"))) {
      return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
    }

    const { repositoryId: repositoryIdRaw } = await context.params;
    const repositoryId = Number(repositoryIdRaw);
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      return NextResponse.json(
        { error: "Invalid repository id", requestId },
        { status: 400 }
      );
    }
    const parsed = initiateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid upload request",
          details: parsed.error.issues.map((issue) => issue.message),
          requestId,
        },
        { status: 400 }
      );
    }

    const userId = await getUserIdFromSession(session.sub);
    await assertNotSystemManagedRepository(repositoryId);
    if (!(await canModifyRepository(repositoryId, userId))) {
      return NextResponse.json({ error: "Not found", requestId }, { status: 404 });
    }

    const config = await getContentPlatformConfig();
    if (!isCanonicalRepositoryUploadActive(config)) {
      timer({ status: "success", mode: "legacy" });
      return NextResponse.json({ mode: "legacy", requestId });
    }
    // The walking skeleton cuts PDF over first. Other existing repository file
    // types remain on the proven legacy processor until their canonical
    // normalizers are enabled in the multimodal milestone.
    if (parsed.data.contentType !== "application/pdf") {
      timer({ status: "success", mode: "legacy", reason: "file_type" });
      return NextResponse.json({ mode: "legacy", requestId });
    }

    const upload = await initiateRepositoryUpload(
      {
        repositoryId,
        userId,
        itemName: parsed.data.itemName,
        fileName: parsed.data.fileName,
        contentType: parsed.data.contentType,
        byteSize: parsed.data.byteSize,
      },
      config
    );
    timer({ status: "success", mode: "canonical" });
    return NextResponse.json({ mode: "canonical", upload, requestId });
  } catch (error) {
    timer({ status: "error" });
    log.error("Failed to initiate canonical repository upload", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to initiate upload",
        requestId,
      },
      { status: 400 }
    );
  }
}
