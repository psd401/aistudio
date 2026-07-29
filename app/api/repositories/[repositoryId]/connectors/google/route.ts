import { listGoogleDriveConnectors } from "@/lib/repositories/google-drive/connector-service";
import {
  repositoryConnectorErrorResponse,
  requireRepositoryConnectorManager,
} from "@/lib/repositories/google-drive/route-access";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";

export async function GET(
  _request: Request,
  context: { params: Promise<{ repositoryId: string }> },
): Promise<Response> {
  const requestId = generateRequestId();
  const timer = startTimer("googleContent.connectors.list");
  const log = createLogger({
    requestId,
    action: "googleContent.connectors.list",
  });
  try {
    const repositoryId = Number((await context.params).repositoryId);
    const manager = await requireRepositoryConnectorManager(repositoryId);
    const connectors = await listGoogleDriveConnectors(
      repositoryId,
      manager.userId,
    );
    timer({ status: "success", connectorCount: connectors.length });
    log.info("Google Drive connectors listed", {
      repositoryId,
      connectorCount: connectors.length,
      userId: manager.userId,
    });
    return Response.json({ connectors });
  } catch (error) {
    timer({ status: "error" });
    log.warn("Google Drive connector list rejected");
    return repositoryConnectorErrorResponse(error);
  }
}
