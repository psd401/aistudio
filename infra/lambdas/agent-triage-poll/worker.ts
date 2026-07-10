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

export interface BatchRecord {
  messageId: string;
  /** FIFO MessageGroupId (userEmail); falls back to messageId if absent. */
  group: string;
  body: string;
}

/**
 * Process a batch of records with FIFO-correct partial-failure reporting.
 * Records arrive in per-group order. Once a message in a group fails, every
 * LATER message in the SAME group must also be reported as a failure and
 * left unprocessed — otherwise SQS redelivers the retried message out of
 * order relative to same-group work the handler already succeeded (a user's
 * `poll` + `sweep`/`learn` can share a batch/group). Records in OTHER groups
 * are unaffected. Pure orchestration (handler injected) so it's unit-testable.
 */
export async function processBatch(
  records: BatchRecord[],
  handle: (msg: QueueMessage) => Promise<void>,
): Promise<{ itemIdentifier: string }[]> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  const failedGroups = new Set<string>();

  for (const record of records) {
    if (failedGroups.has(record.group)) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      const msg = JSON.parse(record.body) as QueueMessage;
      await handle(msg);
    } catch (err) {
      log("ERROR", "worker_message_failed", {
        messageId: record.messageId,
        group: record.group,
        err: err instanceof Error ? err.message : String(err),
      });
      failedGroups.add(record.group);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return batchItemFailures;
}

export const handler: SQSHandler = async (event) => {
  const records: BatchRecord[] = event.Records.map((r) => ({
    messageId: r.messageId,
    group: r.attributes?.MessageGroupId ?? r.messageId,
    body: r.body,
  }));
  const batchItemFailures = await processBatch(records, handleMessage);
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
