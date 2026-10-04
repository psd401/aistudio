/**
 * recordPollResult write ordering (#1855 review).
 *
 * The per-day counters must land in the SAME write that advances the
 * cursor. If they were left to the follow-up trim write, a Lambda that
 * died between the two calls would advance past the tick's messages and
 * those decisions would never reach `dailyStats` — the digest would
 * silently undercount.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { recordPollResult } from "./storage";
import type { DecisionRecord } from "./types";

// Counters older than the retention window are pruned, so use today.
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    messageId: "m1",
    threadId: "t1",
    label: "important",
    source: "content",
    reason: "content:approval",
    confidence: 0.9,
    ts: NOW,
    fromEmail: "a@psd401.net",
    subject: "Please approve",
    ...over,
  };
}

describe("recordPollResult", () => {
  let sendSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => sendSpy?.mockRestore());

  test("dailyStats is written atomically with the cursor, before the trim", async () => {
    const commands: unknown[] = [];
    let getCalls = 0;
    sendSpy = spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(
      (async (command: unknown) => {
        commands.push(command);
        if (command instanceof GetCommand) {
          getCalls += 1;
          // The re-read before the trim fails: the Lambda "dies" here.
          if (getCalls > 1) throw new Error("throttled");
          return {
            Item: {
              userEmail: "u@psd401.net",
              digestTz: "UTC",
              dailyStats: {
                [TODAY]: {
                  total: 3, important: 1, later: 2, news: 0,
                  rule: 3, llm: 0, corrections: 0,
                },
              },
            },
          };
        }
        return {};
      }) as never,
    );

    await expect(
      recordPollResult(
        "u@psd401.net",
        { lastHistoryId: "200", lastPollAt: NOW },
        [decision()],
        [],
      ),
    ).rejects.toThrow("throttled");

    const updates = commands.filter((c) => c instanceof UpdateCommand) as UpdateCommand[];
    expect(updates).toHaveLength(1);
    const first = updates[0].input;
    expect(first.UpdateExpression).toContain("lastHistoryId = :h");
    expect(first.UpdateExpression).toContain("dailyStats = :s");
    const stats = first.ExpressionAttributeValues?.[":s"] as Record<
      string,
      { total: number; important: number }
    >;
    expect(stats[TODAY].total).toBe(4);
    expect(stats[TODAY].important).toBe(2);
  });
});
