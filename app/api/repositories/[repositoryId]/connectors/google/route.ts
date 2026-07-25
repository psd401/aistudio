import { z } from "zod";
import {
  assertGoogleContentSyncEnabled,
  listGoogleDriveConnectors,
  requestGoogleDriveSync,
  upsertSharedDriveConnector,
} from "@/lib/repositories/google-drive/connector-service";
import {
  repositoryConnectorErrorResponse,
  requireRepositoryConnectorManager,
} from "@/lib/repositories/google-drive/route-access";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";

const sharedDriveSchema = z.object({
  sharedDriveId: z.string().trim().min(1).max(256),
  displayName: z.string().trim().min(1).max(255),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ repositoryId: string }> },
): Promise<Response> {
  const timer = startTimer("googleContent.connectors.list");
  try {
    const repositoryId = Number((await context.params).repositoryId);
    const manager = await requireRepositoryConnectorManager(repositoryId);
    const connectors = await listGoogleDriveConnectors(
      repositoryId,
      manager.userId,
    );
    timer({ status: "success", connectorCount: connectors.length });
    return Response.json({ connectors });
  } catch (error) {
    timer({ status: "error" });
    return repositoryConnectorErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ repositoryId: string }> },
): Promise<Response> {
  const requestId = generateRequestId();
  const timer = startTimer("googleContent.connectors.sharedDrive.create");
  const log = createLogger({
    requestId,
    action: "googleContent.connectors.sharedDrive.create",
  });
  try {
    const repositoryId = Number((await context.params).repositoryId);
    const manager = await requireRepositoryConnectorManager(repositoryId);
    await assertGoogleContentSyncEnabled();
    const input = sharedDriveSchema.parse(await request.json());
    const connectorId = await upsertSharedDriveConnector({
      repositoryId,
      userId: manager.userId,
      sharedDriveId: input.sharedDriveId,
      displayName: input.displayName,
    });
    await requestGoogleDriveSync({
      connectorId,
      trigger: "initial",
    }).catch(() => {});
    timer({ status: "success" });
    log.info("Shared Drive connector configured", {
      repositoryId,
      connectorId,
      userId: manager.userId,
    });
    return Response.json({ connectorId }, { status: 201 });
  } catch (error) {
    timer({ status: "error" });
    log.warn("Shared Drive connector configuration rejected");
    return repositoryConnectorErrorResponse(error);
  }
}
