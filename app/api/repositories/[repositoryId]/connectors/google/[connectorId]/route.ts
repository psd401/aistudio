import {
  connectorBelongsToRepository,
  disconnectGoogleDriveConnector,
} from "@/lib/repositories/google-drive/connector-service";
import { revokeGoogleRefreshToken } from "@/lib/repositories/google-drive/oauth";
import {
  repositoryConnectorErrorResponse,
  requireRepositoryConnectorManager,
} from "@/lib/repositories/google-drive/route-access";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { ErrorFactories } from "@/lib/error-utils";

export async function DELETE(
  _request: Request,
  context: {
    params: Promise<{ repositoryId: string; connectorId: string }>;
  },
): Promise<Response> {
  const requestId = generateRequestId();
  const timer = startTimer("googleContent.connector.disconnect");
  const log = createLogger({
    requestId,
    action: "googleContent.connector.disconnect",
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
    const disconnected = await disconnectGoogleDriveConnector({
      connectorId: params.connectorId,
    });
    if (disconnected.encryptedRefreshToken) {
      await revokeGoogleRefreshToken({
        encryptedRefreshToken: disconnected.encryptedRefreshToken,
      }).catch((error) => {
        log.warn("Google token revocation failed after local disconnect", {
          connectorId: params.connectorId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });
    }
    timer({ status: "success" });
    return Response.json({ disconnected: true });
  } catch (error) {
    timer({ status: "error" });
    return repositoryConnectorErrorResponse(error);
  }
}
