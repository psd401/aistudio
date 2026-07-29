import {
  connectorBelongsToRepository,
  requestGoogleDriveSync,
} from "@/lib/repositories/google-drive/connector-service";
import {
  repositoryConnectorErrorResponse,
  requireRepositoryConnectorManager,
} from "@/lib/repositories/google-drive/route-access";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { ErrorFactories } from "@/lib/error-utils";

export async function POST(
  _request: Request,
  context: {
    params: Promise<{ repositoryId: string; connectorId: string }>;
  },
): Promise<Response> {
  const requestId = generateRequestId();
  const timer = startTimer("googleContent.connector.sync");
  const log = createLogger({
    requestId,
    action: "googleContent.connector.sync",
  });
  try {
    const params = await context.params;
    const repositoryId = Number(params.repositoryId);
    await requireRepositoryConnectorManager(repositoryId);
    if (
      !(await connectorBelongsToRepository(params.connectorId, repositoryId))
    ) {
      throw ErrorFactories.authzResourceNotFound(
        "Google Drive connector",
        params.connectorId
      );
    }
    await requestGoogleDriveSync({
      connectorId: params.connectorId,
      trigger: "manual",
    });
    timer({ status: "success" });
    log.info("Google Drive synchronization requested", {
      repositoryId,
      connectorId: params.connectorId,
    });
    return Response.json({ accepted: true }, { status: 202 });
  } catch (error) {
    timer({ status: "error" });
    log.warn("Google Drive synchronization request rejected");
    return repositoryConnectorErrorResponse(error);
  }
}
