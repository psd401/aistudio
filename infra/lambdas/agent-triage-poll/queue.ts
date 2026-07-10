/**
 * SQS work-queue helpers for the multi-tenant fanout (#1172, #996 item 6).
 *
 * The triage poll is fanned out over a FIFO queue: dispatcher.ts enqueues
 * one message per enabled user; worker.ts consumes them. FIFO with
 * MessageGroupId = userEmail gives per-user single-flight (the cursor-safety
 * invariant the old reservedConcurrency=1 provided) while different users
 * run in parallel.
 *
 * Message kinds share the queue:
 *   - poll  : live-triage tick (dispatcher, every 5 min)
 *   - sweep : one initial-inbox-sweep slice (dispatcher kicks it; the worker
 *             re-enqueues a continuation per page until done)
 *   - learn : nightly correction-driven learning (dispatcher, daily rule)
 */

import {
  SQSClient,
  SendMessageCommand,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
} from "@aws-sdk/client-sqs";

export type QueueMessageType = "poll" | "sweep" | "learn";

export interface QueueMessage {
  type: QueueMessageType;
  userEmail: string;
}

const REGION = process.env.AWS_REGION ?? "us-east-1";
const QUEUE_URL = process.env.TRIAGE_WORK_QUEUE_URL ?? "";

let cached: SQSClient | null = null;
function sqs(): SQSClient {
  if (!cached) cached = new SQSClient({ region: REGION });
  return cached;
}

/** SQS caps a MessageDeduplicationId at 128 chars. */
function clampDedupId(id: string): string {
  return id.length <= 128 ? id : id.slice(0, 128);
}

/**
 * Enqueue a single message. `dedupId` MUST be unique per distinct action —
 * e.g. sweep continuations key on the page cursor so consecutive slices are
 * never deduped away, while a poll keys on a 5-minute bucket so a
 * double-dispatch within a tick collapses.
 */
export async function enqueue(msg: QueueMessage, dedupId: string): Promise<void> {
  await sqs().send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(msg),
      MessageGroupId: msg.userEmail,
      MessageDeduplicationId: clampDedupId(dedupId),
    }),
  );
}

/**
 * Enqueue many messages efficiently via SendMessageBatch (10 per call).
 * Returns the number of failed entries (logged by the caller).
 */
export async function enqueueMany(
  items: Array<{ body: QueueMessage; dedupId: string }>,
): Promise<number> {
  let failed = 0;
  for (let i = 0; i < items.length; i += 10) {
    const chunk = items.slice(i, i + 10);
    const entries: SendMessageBatchRequestEntry[] = chunk.map((it, idx) => ({
      Id: String(idx),
      MessageBody: JSON.stringify(it.body),
      MessageGroupId: it.body.userEmail,
      MessageDeduplicationId: clampDedupId(it.dedupId),
    }));
    const resp = await sqs().send(
      new SendMessageBatchCommand({ QueueUrl: QUEUE_URL, Entries: entries }),
    );
    failed += resp.Failed?.length ?? 0;
  }
  return failed;
}
