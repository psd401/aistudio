import {
  getGoogleDriveConnectorCredential,
  listGoogleDriveConnectors,
} from "@/lib/repositories/google-drive/connector-service";
import {
  loadGoogleContentOAuthConfig,
  refreshGoogleAccessToken,
} from "@/lib/repositories/google-drive/oauth";
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
  const timer = startTimer("googleContent.picker.session");
  const log = createLogger({
    requestId,
    action: "googleContent.picker.session",
  });
  try {
    const repositoryId = Number((await context.params).repositoryId);
    const manager = await requireRepositoryConnectorManager(repositoryId);
    const connectors = await listGoogleDriveConnectors(
      repositoryId,
      manager.userId,
    );
    const personal = connectors.find(
      (connector) =>
        connector.authMode === "personal_oauth" &&
        connector.ownedByViewer &&
        connector.status !== "revoked",
    );
    if (!personal) throw new Error("Connector not found");
    const credential = await getGoogleDriveConnectorCredential({
      connectorId: personal.id,
      userId: manager.userId,
    });
    const [token, config] = await Promise.all([
      refreshGoogleAccessToken({
        encryptedRefreshToken: credential.encryptedRefreshToken,
      }),
      loadGoogleContentOAuthConfig(),
    ]);
    timer({ status: "success" });
    log.info("Google Picker session issued", {
      repositoryId,
      connectorId: personal.id,
      userId: manager.userId,
    });
    return Response.json(
      {
        connectorId: personal.id,
        accessToken: token.accessToken,
        expiresInSeconds: token.expiresInSeconds,
        developerKey: config.pickerApiKey,
        appId: config.appId,
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    timer({ status: "error" });
    log.warn("Google Picker session rejected");
    return repositoryConnectorErrorResponse(error);
  }
}
