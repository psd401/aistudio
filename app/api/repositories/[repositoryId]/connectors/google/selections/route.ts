import { z } from "zod";
import {
  connectorBelongsToRepository,
  getGoogleDriveConnectorCredential,
  replaceGoogleDriveSelections,
  requestGoogleDriveSync,
} from "@/lib/repositories/google-drive/connector-service";
import {
  GoogleDriveClient,
  GOOGLE_FOLDER_MIME_TYPE,
  GOOGLE_SHORTCUT_MIME_TYPE,
} from "@/lib/repositories/google-drive";
import { refreshGoogleAccessToken } from "@/lib/repositories/google-drive/oauth";
import { mapWithConcurrency } from "@/lib/repositories/google-drive/bounded-concurrency";
import {
  repositoryConnectorErrorResponse,
  requireRepositoryConnectorManager,
} from "@/lib/repositories/google-drive/route-access";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { apiRateLimit } from "@/lib/rate-limit";

const requestSchema = z.object({
  connectorId: z.string().uuid(),
  fileIds: z.array(z.string().trim().min(1).max(512)).min(1).max(100),
});

const GOOGLE_METADATA_CONCURRENCY = 5;

async function replaceSelections(
  request: Request,
  context: { params: Promise<{ repositoryId: string }> },
): Promise<Response> {
  const requestId = generateRequestId();
  const timer = startTimer("googleContent.selections.replace");
  const log = createLogger({
    requestId,
    action: "googleContent.selections.replace",
  });
  try {
    const repositoryId = Number((await context.params).repositoryId);
    const manager = await requireRepositoryConnectorManager(repositoryId);
    const input = requestSchema.parse(await request.json());
    if (
      !(await connectorBelongsToRepository(input.connectorId, repositoryId))
    ) {
      throw new Error("Connector not found");
    }
    const credential = await getGoogleDriveConnectorCredential({
      connectorId: input.connectorId,
      userId: manager.userId,
    });
    const token = await refreshGoogleAccessToken({
      encryptedRefreshToken: credential.encryptedRefreshToken,
    });
    const drive = new GoogleDriveClient(token.accessToken);
    const selections = await mapWithConcurrency(
      Array.from(new Set(input.fileIds)),
      GOOGLE_METADATA_CONCURRENCY,
      async (fileId) => {
        let file = await drive.getFile(fileId);
        if (file.mimeType === GOOGLE_SHORTCUT_MIME_TYPE) {
          if (!file.shortcutDetails?.targetId) {
            throw new Error("Selected shortcut has no accessible target");
          }
          file = await drive.getFile(
            file.shortcutDetails.targetId,
            file.shortcutDetails.targetResourceKey,
          );
        }
        return {
          externalId: file.id,
          selectionKind:
            file.mimeType === GOOGLE_FOLDER_MIME_TYPE
              ? ("folder" as const)
              : ("file" as const),
          displayName: file.name,
          includeDescendants: true,
        };
      },
    );
    await replaceGoogleDriveSelections({
      connectorId: input.connectorId,
      selections,
    });
    await requestGoogleDriveSync({
      connectorId: input.connectorId,
      trigger: "manual",
    }).catch(() => {});
    timer({ status: "success", selectionCount: selections.length });
    log.info("Google Drive selections replaced", {
      repositoryId,
      connectorId: input.connectorId,
      selectionCount: selections.length,
      userId: manager.userId,
    });
    return Response.json({ selections });
  } catch (error) {
    timer({ status: "error" });
    log.warn("Google Drive selection rejected");
    return repositoryConnectorErrorResponse(error);
  }
}

/**
 * Selection verification performs provider metadata calls, so it receives the
 * same per-user request budget as uploads in addition to bounded call
 * concurrency inside each request.
 */
export const POST = apiRateLimit.upload(replaceSelections);
