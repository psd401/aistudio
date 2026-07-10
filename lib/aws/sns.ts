/**
 * Shared SNS best-effort publish helper.
 *
 * Extracted from the copies that had grown in `lib/content/events.ts` and
 * `lib/safety/bedrock-guardrails-service.ts` (which had already drifted on the
 * Subject-truncation logic). Owns the two drift-prone mechanics — the 100-char
 * Subject cap and the swallow-and-report best-effort send — in one place, so a
 * fix to either applies to every caller. Client construction stays with the
 * caller (a module-cached default here, or a service's own region-configured
 * instance) so per-service region / disabled-mode behavior is unaffected.
 */

import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

/** SNS Subject is capped at 100 chars by the API — a longer one fails the publish. */
const SUBJECT_MAX = 100;

/** Cap an SNS Subject to the API limit, marking truncation with an ellipsis. */
export function capSnsSubject(subject: string): string {
  return subject.length <= SUBJECT_MAX
    ? subject
    : subject.slice(0, SUBJECT_MAX - 3) + "...";
}

let cachedClient: SNSClient | null = null;

/**
 * A process-cached default SNS client. Region resolves from `AWS_REGION`
 * (us-east-1 fallback for local/dev); credentials resolve from the ECS task role
 * (IMDSv2) in prod and the default chain locally. Callers that need a specific
 * region (or a disabled-mode client) pass their own via `client`.
 */
export function getSnsClient(): SNSClient {
  if (!cachedClient) {
    cachedClient = new SNSClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  }
  return cachedClient;
}

export interface SnsPublishInput {
  /** The SNS client to send with; defaults to the process-cached client. */
  client?: SNSClient;
  topicArn: string;
  /** Capped to 100 chars automatically. */
  subject: string;
  message: string;
  messageAttributes?: Record<string, { DataType: string; StringValue: string }>;
}

/**
 * Publish to SNS best-effort: caps the Subject, sends, and NEVER throws — a
 * notification hiccup must not roll back the caller's already-committed work.
 * Returns `{ sent: true }` on success or `{ sent: false, error }` on a swallowed
 * failure, so the caller can log with its own context/message.
 */
export async function snsPublishBestEffort(
  input: SnsPublishInput
): Promise<{ sent: boolean; error?: unknown }> {
  const client = input.client ?? getSnsClient();
  try {
    await client.send(
      new PublishCommand({
        TopicArn: input.topicArn,
        Subject: capSnsSubject(input.subject),
        Message: input.message,
        MessageAttributes: input.messageAttributes,
      })
    );
    return { sent: true };
  } catch (error) {
    return { sent: false, error };
  }
}
