/**
 * Digest window tests (#1855 addendum 1).
 *
 * The acceptance criterion: a window holding MORE than the 20-entry
 * `recentDecisions` buffer must report its real total.
 *
 * Run: bun test digest-window.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  type DailyStat,
  describeWindow,
  digestWindowKeys,
  MAX_DIGEST_WINDOW_DAYS,
  sumDailyStats,
} from "./digest-window";

function stat(over: Partial<DailyStat> = {}): DailyStat {
  return {
    total: 0,
    important: 0,
    later: 0,
    news: 0,
    rule: 0,
    llm: 0,
    corrections: 0,
    ...over,
  };
}

describe("digestWindowKeys", () => {
  test("a daily digest covers yesterday and today", () => {
    expect(
      digestWindowKeys("2026-07-10T15:00:00Z", "2026-07-09T15:00:00Z", "UTC"),
    ).toEqual(["2026-07-09", "2026-07-10"]);
  });

  test("with no previous digest it still reports a sane window", () => {
    expect(digestWindowKeys("2026-07-10T15:00:00Z", undefined, "UTC")).toEqual([
      "2026-07-09",
      "2026-07-10",
    ]);
  });

  test("a gap since the last digest is covered, not dropped", () => {
    expect(
      digestWindowKeys("2026-07-10T15:00:00Z", "2026-07-07T15:00:00Z", "UTC"),
    ).toEqual(["2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10"]);
  });

  test("a very long gap is clamped", () => {
    // Otherwise one catch-up digest claims a quarter's mail arrived
    // overnight.
    const keys = digestWindowKeys(
      "2026-07-10T15:00:00Z",
      "2026-01-01T15:00:00Z",
      "UTC",
    );
    // Clamped to the most recent 14 days — not collapsed to the 2-day
    // first-run default, which would drop 12 days of real counters.
    expect(keys.length).toBe(MAX_DIGEST_WINDOW_DAYS);
    expect(keys[0]).toBe("2026-06-27");
    expect(keys[keys.length - 1]).toBe("2026-07-10");
  });

  test("the window is computed in the user's timezone", () => {
    // 02:00 UTC is still the 9th in Seattle, so "today" is the 9th there.
    expect(
      digestWindowKeys("2026-07-10T02:00:00Z", undefined, "America/Los_Angeles"),
    ).toEqual(["2026-07-08", "2026-07-09"]);
  });

  test("a last-digest stamp in the future cannot invert the window", () => {
    const keys = digestWindowKeys(
      "2026-07-10T15:00:00Z",
      "2026-08-01T15:00:00Z",
      "UTC",
    );
    expect(keys).toEqual(["2026-07-10"]);
  });
});

describe("sumDailyStats", () => {
  test("THE bug: a 137-message day reports 137, not 20", () => {
    const stats = {
      "2026-07-09": stat({ total: 60, important: 8, later: 40, news: 12 }),
      "2026-07-10": stat({ total: 77, important: 11, later: 51, news: 15 }),
    };
    const keys = digestWindowKeys(
      "2026-07-10T15:00:00Z",
      "2026-07-09T15:00:00Z",
      "UTC",
    );
    const total = sumDailyStats(stats, keys);
    expect(total.total).toBe(137);
    expect(total.important).toBe(19);
    expect(total.later).toBe(91);
    expect(total.news).toBe(27);
  });

  test("days outside the window are not counted", () => {
    const stats = {
      "2026-07-01": stat({ total: 999 }),
      "2026-07-10": stat({ total: 3 }),
    };
    expect(sumDailyStats(stats, ["2026-07-10"]).total).toBe(3);
  });

  test("a user with no counters yet reports zero rather than crashing", () => {
    expect(sumDailyStats(undefined, ["2026-07-10"])).toMatchObject({ total: 0 });
    expect(sumDailyStats({}, ["2026-07-10"]).total).toBe(0);
  });
});

describe("describeWindow", () => {
  test("names the window the card is reporting", () => {
    expect(describeWindow(["2026-07-10"])).toBe("today");
    expect(describeWindow(["2026-07-09", "2026-07-10"])).toBe("since yesterday");
    expect(describeWindow(["a", "b", "c"])).toBe("over the last 3 days");
  });
});
