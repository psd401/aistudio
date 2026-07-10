/**
 * Unit tests for FIFO dedup-id clamping (#1172).
 *
 * Run: bun test queue.test.ts
 */
import { describe, expect, test } from "bun:test";
import { clampDedupId } from "./queue";

describe("clampDedupId", () => {
  test("short id passes through unchanged", () => {
    expect(clampDedupId("poll:hagelk@psd401.net:12345")).toBe(
      "poll:hagelk@psd401.net:12345",
    );
  });

  test("id at exactly 128 chars is not hashed", () => {
    const id = "a".repeat(128);
    expect(clampDedupId(id)).toBe(id);
  });

  test("over-long id is hashed (fits under 128) and stays distinct by suffix", () => {
    const longEmail = "x".repeat(130) + "@psd401.net";
    // Two sweep continuations differ only in the page-cursor suffix — the
    // right-truncation bug would collapse these; hashing must not.
    const a = clampDedupId(`sweep:${longEmail}:pageTokenAAAA`);
    const b = clampDedupId(`sweep:${longEmail}:pageTokenBBBB`);
    expect(a.length).toBeLessThanOrEqual(128);
    expect(b.length).toBeLessThanOrEqual(128);
    expect(a).not.toBe(b);
  });

  test("identical over-long ids hash identically (dedup still works)", () => {
    const id = `poll:${"y".repeat(200)}:42`;
    expect(clampDedupId(id)).toBe(clampDedupId(id));
  });
});
