/** @jest-environment node */

import { mapWithConcurrency } from "@/lib/repositories/google-drive/bounded-concurrency";

describe("mapWithConcurrency", () => {
  test("preserves result order and never exceeds the provider-call limit", async () => {
    let active = 0;
    let peak = 0;
    const values = Array.from({ length: 20 }, (_, index) => index);

    const results = await mapWithConcurrency(values, 5, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual(values.map((value) => value * 2));
    expect(peak).toBe(5);
  });

  test("rejects invalid concurrency instead of silently running unbounded", async () => {
    await expect(
      mapWithConcurrency([1], 0, async (value) => value),
    ).rejects.toThrow("positive safe integer");
  });
});
