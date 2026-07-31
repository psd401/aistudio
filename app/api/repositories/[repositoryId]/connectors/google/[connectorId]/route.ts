import {
  connectorBelongsToRepository,
  disconnectGoogleDriveConnector,
  setGoogleDriveConnectorPaused,
} from "@/lib/repositories/google-drive/connector-service";
import { revokeGoogleRefreshToken } from "@/lib/repositories/google-drive/oauth";
import {
  repositoryConnectorErrorResponse,
  requireRepositoryConnectorManager,
} from "@/lib/repositories/google-drive/route-access";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { ErrorFactories } from "@/lib/error-utils";
import { z } from "zod";

const connectorOperationSchema = z.object({
  operation: z.enum(["pause", "resume"]),
});

export async function PATCH(
  request: Request,
  context: {
    params: Promise<{ repositoryId: string; connectorId: string }>;
  },
): Promise<Response> {
  const requestId = generateRequestId();
  const timer = startTimer("googleContent.connector.lifecycle");
  const log = createLogger({
    requestId,
    action: "googleContent.connector.lifecycle",
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
    const parsed = connectorOperationSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        { error: "operation must be pause or resume", requestId },
        { status: 400 },
      );
    }
    const result = await setGoogleDriveConnectorPaused({
      connectorId: params.connectorId,
      paused: parsed.data.operation === "pause",
    });
    timer({ status: "success", connectorStatus: result.status });
    log.info("Google Drive connector lifecycle changed", {
      connectorId: params.connectorId,
      status: result.status,
    });
    return Response.json(result);
  } catch (error) {
    timer({ status: "error" });
    return repositoryConnectorErrorResponse(error);
  }
}

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
