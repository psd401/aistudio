/**
 * Unit tests for the dispatcher's sweep-kick decision (#1172).
 *
 * Run: bun test dispatcher.test.ts
 */
import { describe, expect, test } from "bun:test";
import { sweepNeedsKick } from "./dispatcher";
import type { SweepState } from "./types";

const NOW = Date.parse("2026-07-10T12:00:00Z");

function sweep(over: Partial<SweepState>): SweepState {
  return {
    status: "running",
    processed: 0,
    labeled: 0,
    windowDays: 30,
    cap: 1000,
    ...over,
  };
}

describe("sweepNeedsKick", () => {
  test("no sweep → no kick", () => {
    expect(sweepNeedsKick(undefined, NOW)).toBe(false);
  });

  test("pending → always kick", () => {
    expect(sweepNeedsKick(sweep({ status: "pending" }), NOW)).toBe(true);
  });

  test("complete / error → never kick", () => {
    expect(sweepNeedsKick(sweep({ status: "complete" }), NOW)).toBe(false);
    expect(sweepNeedsKick(sweep({ status: "error" }), NOW)).toBe(false);
  });

  test("running + fresh update → no kick", () => {
    const updatedAt = new Date(NOW - 60_000).toISOString(); // 1 min ago
    expect(sweepNeedsKick(sweep({ status: "running", updatedAt }), NOW)).toBe(false);
  });

  test("running + stale update (>15 min) → kick", () => {
    const updatedAt = new Date(NOW - 20 * 60_000).toISOString(); // 20 min ago
    expect(sweepNeedsKick(sweep({ status: "running", updatedAt }), NOW)).toBe(true);
  });

  test("running with NaN/invalid updatedAt → kick (treated as very old)", () => {
    expect(sweepNeedsKick(sweep({ status: "running", updatedAt: "not-a-date" }), NOW)).toBe(true);
  });

  test("running with missing updatedAt → kick", () => {
    expect(sweepNeedsKick(sweep({ status: "running", updatedAt: undefined }), NOW)).toBe(true);
  });
});
