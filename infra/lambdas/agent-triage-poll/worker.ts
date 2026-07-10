/**
 * Triage WORKER Lambda (#1172, #996 item 6).
 *
 * SQS event source over the FIFO work queue. Each record is one user's
 * unit of work; per-user single-flight is guaranteed by the FIFO group
 * (MessageGroupId = userEmail). Partial-batch failures are reported so a
 * poison message only blocks its own group and eventually hits the DLQ.
 *
 * Message kinds:
 *   - poll  → processUser (live triage)
 *   - sweep → one initial-inbox-sweep slice; re-enqueue a continuation
 *             per page until the sweep completes
 *   - learn → nightly correction-driven learning
 */

import type { SQSHandler } from "aws-lambda";

import { log, processUser } from "./index";
import { runSweepSlice } from "./sweep";
import { runLearning } from "./learn";
import { getTriageRow } from "./storage";
import { enqueue, type QueueMessage } from "./queue";

export const handler: SQSHandler = async (event) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const msg = JSON.parse(record.body) as QueueMessage;
      await handleMessage(msg);
    } catch (err) {
      log("ERROR", "worker_message_failed", {
        messageId: record.messageId,
        err: err instanceof Error ? err.message : String(err),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

async function handleMessage(msg: QueueMessage): Promise<void> {
  if (!msg || typeof msg.userEmail !== "string" || !msg.type) {
    log("WARN", "worker_bad_message", { msg });
    return;
  }

  const row = await getTriageRow(msg.userEmail);
  if (!row) {
    log("INFO", "worker_skip_no_row", { user: msg.userEmail, type: msg.type });
    return;
  }
  // A user disabled between dispatch and processing — drop the work rather
  // than act on stale intent. (Sweep/learn are meaningless when paused.)
  if (!row.enabled) {
    log("INFO", "worker_skip_disabled", { user: msg.userEmail, type: msg.type });
    return;
  }

  switch (msg.type) {
    case "poll":
      await processUser(row);
      return;

    case "sweep": {
      const { sweep, shouldContinue } = await runSweepSlice(row);
      if (shouldContinue) {
        // Continuation dedup keys on the page cursor so consecutive slices
        // are never collapsed by FIFO dedup.
        await enqueue(
          { type: "sweep", userEmail: msg.userEmail },
          `sweep:${msg.userEmail}:${sweep.pageToken ?? "next"}`,
        );
      }
      return;
    }

    case "learn":
      await runLearning(row);
      return;

    default:
      log("WARN", "worker_unknown_type", { user: msg.userEmail, type: msg.type });
      return;
  }
}
