import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { executeTransaction } from "@/lib/db/drizzle-client";
import { repositoryConnectors } from "@/lib/db/schema";
import { requestGoogleDriveSync } from "@/lib/repositories/google-drive/connector-service";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { ErrorFactories } from "@/lib/error-utils";

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export async function POST(request: Request): Promise<Response> {
  const requestId = generateRequestId();
  const timer = startTimer("googleContent.webhook");
  const log = createLogger({ requestId, action: "googleContent.webhook" });
  const channelId = request.headers.get("x-goog-channel-id");
  const channelToken = request.headers.get("x-goog-channel-token");
  const resourceId = request.headers.get("x-goog-resource-id");
  const resourceState = request.headers.get("x-goog-resource-state");
  const messageNumberValue = request.headers.get("x-goog-message-number");
  const messageNumber =
    messageNumberValue && /^\d+$/.test(messageNumberValue)
      ? BigInt(messageNumberValue)
      : null;
  if (!channelId || !channelToken || !resourceId || messageNumber === null) {
    timer({ status: "error", reason: "invalid_headers" });
    return Response.json({ error: "Invalid notification" }, { status: 400 });
  }

  try {
    const connectorId = await executeTransaction(async (tx) => {
      const [connector] = await tx
        .select({
          id: repositoryConnectors.id,
          watchResourceId: repositoryConnectors.watchResourceId,
          watchTokenHash: repositoryConnectors.watchTokenHash,
          lastNotificationNumber: repositoryConnectors.lastNotificationNumber,
        })
        .from(repositoryConnectors)
        .where(eq(repositoryConnectors.watchChannelId, channelId))
        .limit(1)
        .for("update");
      if (
        !connector ||
        connector.watchResourceId !== resourceId ||
        !connector.watchTokenHash ||
        !safeHashEqual(connector.watchTokenHash, tokenHash(channelToken))
      ) {
        throw ErrorFactories.authzResourceNotFound(
          "Google Drive notification channel",
          channelId
        );
      }
      if (
        connector.lastNotificationNumber !== null &&
        messageNumber <= connector.lastNotificationNumber
      ) {
        return null;
      }
      const [updated] = await tx
        .update(repositoryConnectors)
        .set({
          lastNotificationNumber: messageNumber,
          nextSyncAt: new Date(),
          metadata: sql`${repositoryConnectors.metadata} || ${JSON.stringify({
            lastNotificationState: resourceState ?? "change",
          })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(repositoryConnectors.id, connector.id),
            or(
              isNull(repositoryConnectors.lastNotificationNumber),
              lt(repositoryConnectors.lastNotificationNumber, messageNumber),
            ),
          ),
        )
        .returning({ id: repositoryConnectors.id });
      return updated?.id ?? null;
    }, "googleDrive.acceptNotification");
    if (connectorId) {
      await requestGoogleDriveSync({
        connectorId,
        trigger: "notification",
      }).catch(() => {});
    }
    timer({ status: "success", duplicate: !connectorId });
    return new Response(null, { status: 204 });
  } catch {
    timer({ status: "error", reason: "notification_rejected" });
    log.warn("Google Drive notification rejected");
    // Do not disclose whether a channel id, resource id, or token matched.
    return Response.json({ error: "Invalid notification" }, { status: 404 });
  }
}
