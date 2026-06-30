/**
 * Atrium content events (best-effort SNS publish)
 *
 * Issue #1055 (Epic #1059, Atrium Phase 5 — Agent access). Emits content
 * lifecycle events on an SNS topic (§27) so downstream automations subscribe
 * instead of polling: re-index on publish, run connector pushes, notify a
 * channel, drive the public-publish approval queue.
 *
 * Contract:
 *  - Emit AFTER the DB commit, never inside a transaction.
 *  - Best-effort: a publish failure is logged, never thrown — the content
 *    mutation already succeeded and must not be rolled back by a bus hiccup.
 *  - No-op (debug log only) when `ATRIUM_EVENTS_TOPIC_ARN` is unset, so local
 *    dev, tests, and the pre-deploy window work without the topic.
 *  - The publish path emits exactly once per successful publish.
 *
 * Mirrors the SNS usage in `lib/safety/bedrock-guardrails-service.ts`.
 */

import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { createLogger } from "@/lib/logger";

export type ContentEventType =
  | "content.published"
  | "content.version_created"
  | "content.unpublished"
  | "content.public_publish_requested";

export interface ContentEventPayload {
  objectId: string;
  slug?: string;
  versionId?: string;
  destination?: string;
  /** "human" | "agent" — who triggered the event. */
  actorKind?: "human" | "agent";
  agentLabel?: string | null;
  requestId?: string | null;
  [key: string]: unknown;
}

/** SNS `Subject` is capped at 100 chars by the API — a longer one fails the publish. */
function buildSubject(type: ContentEventType): string {
  const subject = `Atrium: ${type}`;
  return subject.length > 100 ? subject.slice(0, 100) : subject;
}

let snsClientCache: SNSClient | null = null;

function getSnsClient(): SNSClient {
  if (snsClientCache) return snsClientCache;
  // Credentials resolve automatically from the ECS task role (IMDSv2) in prod
  // and from the default chain locally.
  snsClientCache = new SNSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
  });
  return snsClientCache;
}

export const contentEvents = {
  /**
   * Publish a content lifecycle event. Best-effort: returns silently on failure
   * or when no topic is configured.
   */
  async emit(type: ContentEventType, payload: ContentEventPayload): Promise<void> {
    const log = createLogger({
      requestId: payload.requestId ?? undefined,
      action: "content.events.emit",
    });

    const topicArn = process.env.ATRIUM_EVENTS_TOPIC_ARN;
    if (!topicArn) {
      log.debug("ATRIUM_EVENTS_TOPIC_ARN unset; skipping content event", {
        type,
        objectId: payload.objectId,
      });
      return;
    }

    try {
      await getSnsClient().send(
        new PublishCommand({
          TopicArn: topicArn,
          Subject: buildSubject(type),
          Message: JSON.stringify({
            event: type,
            ...payload,
            // Stamp at emit time; callers need not thread a clock through.
            emittedAt: new Date().toISOString(),
          }),
          MessageAttributes: {
            eventType: { DataType: "String", StringValue: type },
          },
        })
      );
      log.info("Emitted content event", { type, objectId: payload.objectId });
    } catch (err) {
      log.error("Failed to emit content event", {
        type,
        objectId: payload.objectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
