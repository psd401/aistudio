/** @jest-environment node */

import { fillDailySeries, dayKey, dailyWindowStart } from "@/lib/atrium/usage-series";

describe("dailyWindowStart", () => {
  it("is the UTC midnight that opens the first day of the window fillDailySeries builds", () => {
    const today = new Date("2026-09-01T17:45:00Z");
    expect(dailyWindowStart(3, today).toISOString()).toBe("2026-08-30T00:00:00.000Z");
    expect(fillDailySeries([], 3, today)[0].day).toBe("2026-08-30");
  });

  it("a one-day window starts at today's UTC midnight", () => {
    expect(dailyWindowStart(1, new Date("2026-09-01T00:30:00Z")).toISOString()).toBe(
      "2026-09-01T00:00:00.000Z"
    );
  });
});

describe("fillDailySeries", () => {
  const today = new Date("2026-09-01T17:45:00Z");

  it("returns a contiguous window ending today, zero-filled", () => {
    const series = fillDailySeries([], 3, today);
    expect(series.map((p) => p.day)).toEqual(["2026-08-30", "2026-08-31", "2026-09-01"]);
    expect(series.every((p) => p.created === 0 && p.updated === 0 && p.published === 0)).toBe(
      true
    );
  });

  it("places points on their days and keeps the rest at zero", () => {
    const series = fillDailySeries(
      [{ day: "2026-08-31", created: 2, updated: 5, published: 1 }],
      3,
      today
    );
    expect(series[1]).toEqual({ day: "2026-08-31", created: 2, updated: 5, published: 1 });
    expect(series[0].created + series[2].created).toBe(0);
  });

  it("drops points outside the window and sums duplicate days", () => {
    const series = fillDailySeries(
      [
        { day: "2026-08-01", created: 9, updated: 9, published: 9 },
        { day: "2026-09-01", created: 1, updated: 0, published: 0 },
        { day: "2026-09-01", created: 2, updated: 1, published: 1 },
      ],
      2,
      today
    );
    expect(series).toEqual([
      { day: "2026-08-31", created: 0, updated: 0, published: 0 },
      { day: "2026-09-01", created: 3, updated: 1, published: 1 },
    ]);
  });

  it("crosses a month boundary in UTC, not local time", () => {
    const series = fillDailySeries([], 2, new Date("2026-09-01T02:00:00Z"));
    expect(series.map((p) => p.day)).toEqual(["2026-08-31", "2026-09-01"]);
  });

  it("dayKey is the UTC calendar day", () => {
    expect(dayKey(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");
  });
});
