/**
 * Per-day counter tests (#1855 addendum 1).
 *
 * Run: bun test daily-stats.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  accumulateDailyStats,
  dayKey,
  dayKeysBetween,
  DAILY_STATS_RETENTION_DAYS,
  shiftDayKey,
  sumDailyStats,
} from "./daily-stats";
import type { CorrectionRecord, DecisionRecord } from "./types";

const NOW_DATE = new Date("2026-07-10T12:00:00Z");

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    messageId: Math.random().toString(36).slice(2),
    threadId: "t",
    label: "later",
    source: "llm",
    reason: "r",
    confidence: 0.7,
    ts: "2026-07-10T18:00:00Z",
    fromEmail: "a@b.com",
    subject: "s",
    ...over,
  };
}

describe("dayKey", () => {
  test("uses the user's timezone, not UTC", () => {
    // 02:00 UTC on the 11th is still the evening of the 10th in Seattle.
    // Getting this wrong files a message under the wrong digest.
    expect(dayKey("2026-07-11T02:00:00Z", "America/Los_Angeles")).toBe(
      "2026-07-10",
    );
    expect(dayKey("2026-07-11T02:00:00Z", "UTC")).toBe("2026-07-11");
  });

  test("falls back to UTC for an unknown zone instead of throwing", () => {
    expect(dayKey("2026-07-11T02:00:00Z", "Mars/Olympus")).toBe("2026-07-11");
  });

  test("an unparseable timestamp yields no key", () => {
    expect(dayKey("not-a-date", "UTC")).toBe("");
  });
});

describe("shiftDayKey / dayKeysBetween", () => {
  test("crosses a month boundary", () => {
    expect(shiftDayKey("2026-08-01", -1)).toBe("2026-07-31");
    expect(shiftDayKey("2026-02-28", 1)).toBe("2026-03-01");
  });

  test("an inclusive range", () => {
    expect(dayKeysBetween("2026-07-09", "2026-07-11")).toEqual([
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
    ]);
  });

  test("an inverted range is empty", () => {
    expect(dayKeysBetween("2026-07-11", "2026-07-09")).toEqual([]);
  });
});

describe("accumulateDailyStats", () => {
  test("THE bug: a day's total is not capped at the 20-entry buffer", () => {
    // `recentDecisions` is trimmed to 20, which is why every digest read
    // "20 messages sorted in the last 24h". The counters must say 57.
    const decisions = Array.from({ length: 57 }, (_, i) =>
      decision({ label: i % 3 === 0 ? "important" : "later" }),
    );
    const stats = accumulateDailyStats(undefined, decisions, [], "UTC", NOW_DATE);
    expect(stats["2026-07-10"].total).toBe(57);
    expect(stats["2026-07-10"].important).toBe(19);
    expect(stats["2026-07-10"].later).toBe(38);
  });

  test("adds to a day already recorded rather than replacing it", () => {
    const first = accumulateDailyStats(undefined, [decision()], [], "UTC", NOW_DATE);
    const second = accumulateDailyStats(first, [decision()], [], "UTC", NOW_DATE);
    expect(second["2026-07-10"].total).toBe(2);
  });

  test("splits counts by label and by rule-vs-model", () => {
    const stats = accumulateDailyStats(
      undefined,
      [
        decision({ label: "important", source: "rule" }),
        decision({ label: "news", source: "content" }),
        decision({ label: "later", source: "llm" }),
      ],
      [],
      "UTC",
      NOW_DATE,
    );
    const day = stats["2026-07-10"];
    expect(day).toMatchObject({
      total: 3,
      important: 1,
      later: 1,
      news: 1,
      llm: 1,
      // `content` is deterministic and costs no model call, so it counts
      // on the rule side of the split.
      rule: 2,
    });
  });

  test("corrections are counted on the day they happened", () => {
    const correction: CorrectionRecord = {
      messageId: "m",
      fromLabel: "important",
      toLabel: "archived",
      ts: "2026-07-09T10:00:00Z",
    };
    const stats = accumulateDailyStats(undefined, [], [correction], "UTC", NOW_DATE);
    expect(stats["2026-07-09"].corrections).toBe(1);
    expect(stats["2026-07-09"].total).toBe(0);
  });

  test("days past the retention window are dropped", () => {
    const now = new Date("2026-07-10T12:00:00Z");
    const stale = shiftDayKey("2026-07-10", -(DAILY_STATS_RETENTION_DAYS + 5));
    const kept = shiftDayKey("2026-07-10", -3);
    const existing = {
      [stale]: { total: 9, important: 0, later: 9, news: 0, rule: 9, llm: 0, corrections: 0 },
      [kept]: { total: 4, important: 0, later: 4, news: 0, rule: 4, llm: 0, corrections: 0 },
    };
    const stats = accumulateDailyStats(existing, [], [], "UTC", now);
    expect(stats[stale]).toBeUndefined();
    expect(stats[kept].total).toBe(4);
  });

  test("a decision with a garbage timestamp is skipped, not thrown on", () => {
    const stats = accumulateDailyStats(
      undefined,
      [decision({ ts: "nope" }), decision()],
      [],
      "UTC",
      NOW_DATE,
    );
    expect(Object.keys(stats)).toEqual(["2026-07-10"]);
    expect(stats["2026-07-10"].total).toBe(1);
  });
});

describe("sumDailyStats", () => {
  test("totals across the window and ignores missing days", () => {
    const stats = accumulateDailyStats(
      undefined,
      [
        decision({ ts: "2026-07-09T10:00:00Z", label: "important" }),
        decision({ ts: "2026-07-10T10:00:00Z", label: "later" }),
      ],
      [],
      "UTC",
      NOW_DATE,
    );
    const total = sumDailyStats(stats, [
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
    ]);
    expect(total.total).toBe(2);
    expect(total.important).toBe(1);
  });

  test("an absent map totals to zero", () => {
    expect(sumDailyStats(undefined, ["2026-07-10"]).total).toBe(0);
  });
});
