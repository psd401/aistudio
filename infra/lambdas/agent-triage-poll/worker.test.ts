/**
 * Unit tests for the worker's FIFO-correct batch failure reporting (#1172).
 *
 * Run: bun test worker.test.ts
 */
import { describe, expect, test } from "bun:test";
import { processBatch, type BatchRecord } from "./worker";
import type { QueueMessage } from "./queue";

function rec(messageId: string, group: string, type: QueueMessage["type"]): BatchRecord {
  return { messageId, group, body: JSON.stringify({ type, userEmail: group }) };
}

describe("processBatch (FIFO partial failures)", () => {
  test("all succeed → no failures", async () => {
    const records = [
      rec("1", "a@x.com", "poll"),
      rec("2", "b@x.com", "poll"),
    ];
    const out = await processBatch(records, async () => {});
    expect(out).toEqual([]);
  });

  test("a failure fails every LATER record in the same group", async () => {
    // Group a@x.com: poll(1) fails → sweep(2) + learn(3) must also fail.
    // Group b@x.com: unaffected, succeeds.
    const records = [
      rec("1", "a@x.com", "poll"),
      rec("2", "a@x.com", "sweep"),
      rec("3", "a@x.com", "learn"),
      rec("4", "b@x.com", "poll"),
    ];
    const out = await processBatch(records, async (msg) => {
      if (msg.type === "poll" && msg.userEmail === "a@x.com") {
        throw new Error("boom");
      }
    });
    expect(out.map((f) => f.itemIdentifier).sort()).toEqual(["1", "2", "3"]);
  });

  test("other groups still succeed when one group fails", async () => {
    const records = [
      rec("1", "a@x.com", "poll"), // fails
      rec("2", "b@x.com", "poll"), // ok
      rec("3", "c@x.com", "poll"), // ok
    ];
    const out = await processBatch(records, async (msg) => {
      if (msg.userEmail === "a@x.com") throw new Error("boom");
    });
    expect(out.map((f) => f.itemIdentifier)).toEqual(["1"]);
  });

  test("later records in a failed group are NOT handled (no out-of-order work)", async () => {
    const handled: string[] = [];
    const records = [
      rec("1", "a@x.com", "poll"),
      rec("2", "a@x.com", "sweep"),
    ];
    await processBatch(records, async (msg) => {
      handled.push(`${msg.userEmail}:${msg.type}`);
      if (msg.type === "poll") throw new Error("boom");
    });
    // sweep must never run after poll failed for the same user.
    expect(handled).toEqual(["a@x.com:poll"]);
  });
});
