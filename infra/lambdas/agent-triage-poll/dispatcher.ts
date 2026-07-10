/**
 * Triage DISPATCHER Lambda (#1172, #996 item 6).
 *
 * Replaces the old in-Lambda serial user loop. Triggered by:
 *   - the 5-minute EventBridge rule (input { job: "poll" }) → one `poll`
 *     message per enabled user, plus a `sweep` kick for any user whose
 *     initial-inbox sweep is pending or has stalled
 *   - the daily EventBridge rule (input { job: "learn" }) → one `learn`
 *     message per enabled user
 *
 * The dispatcher does no per-user Gmail/Bedrock work — it just scans the
 * table and enqueues. One user's slowness or failure can no longer delay
 * another user's tick.
 */

import type { Handler } from "aws-lambda";

import { log } from "./index";
import { listEnabledUsers } from "./storage";
import { enqueueMany, type QueueMessage } from "./queue";
import type { SweepState } from "./types";

interface DispatchEvent {
  job?: "poll" | "learn";
}

/** A running sweep with no update for this long is treated as stalled and
 * re-kicked from its saved page cursor. */
const SWEEP_STALE_MS = 15 * 60_000;

export function sweepNeedsKick(s: SweepState | undefined, now: number): boolean {
  if (!s) return false;
  if (s.status === "pending") return true;
  if (s.status === "running") {
    const parsed = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
    // An unparseable updatedAt → NaN → every comparison is false, which would
    // strand the stalled sweep. Treat NaN as "very old" so it gets re-kicked.
    const updated = Number.isNaN(parsed) ? 0 : parsed;
    return now - updated > SWEEP_STALE_MS;
  }
  return false; // complete / error → dispatcher leaves it alone
}

export const handler: Handler<DispatchEvent, void> = async (event) => {
  const t0 = Date.now();
  const job: "poll" | "learn" = event?.job === "learn" ? "learn" : "poll";
  const users = await listEnabledUsers();

  const now = Date.now();
  const bucket = Math.floor(now / 300_000); // 5-min dedup bucket
  const today = new Date(now).toISOString().slice(0, 10);

  const batch: Array<{ body: QueueMessage; dedupId: string }> = [];
  let sweepKicks = 0;

  for (const row of users) {
    if (job === "learn") {
      batch.push({
        body: { type: "learn", userEmail: row.userEmail },
        dedupId: `learn:${row.userEmail}:${today}`,
      });
      continue;
    }

    // poll job
    batch.push({
      body: { type: "poll", userEmail: row.userEmail },
      dedupId: `poll:${row.userEmail}:${bucket}`,
    });

    if (sweepNeedsKick(row.sweep, now)) {
      batch.push({
        body: { type: "sweep", userEmail: row.userEmail },
        dedupId: `sweep:${row.userEmail}:kick:${bucket}`,
      });
      sweepKicks++;
    }
  }

  const failed = await enqueueMany(batch);

  log("INFO", "dispatch_complete", {
    job,
    users: users.length,
    enqueued: batch.length,
    sweep_kicks: sweepKicks,
    failed,
    elapsed_ms: Date.now() - t0,
  });
};
