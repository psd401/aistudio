/** @jest-environment node */

import { recentSince, WHATS_NEW_DAYS } from "@/lib/atrium/recent-window";

describe("recentSince", () => {
  it("is `days` ago, truncated to the top of the hour (UTC)", () => {
    const now = new Date("2026-09-01T17:45:12.345Z");
    expect(recentSince(7, now)).toBe("2026-08-25T17:00:00.000Z");
  });

  it("is stable across renders within the same hour", () => {
    const a = recentSince(7, new Date("2026-09-01T17:01:00Z"));
    const b = recentSince(7, new Date("2026-09-01T17:59:59Z"));
    expect(a).toBe(b);
  });

  it("moves with the clock once the hour rolls over", () => {
    const a = recentSince(7, new Date("2026-09-01T17:59:59Z"));
    const b = recentSince(7, new Date("2026-09-01T18:00:00Z"));
    expect(a).not.toBe(b);
  });

  it("defaults to the What's-new window", () => {
    const now = new Date("2026-09-01T00:30:00Z");
    expect(recentSince(undefined, now)).toBe(recentSince(WHATS_NEW_DAYS, now));
  });
});
