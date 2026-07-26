/**
 * Unit tests for the library bulk fan-out runner (#1336 review follow-up).
 *
 * Pins the selection-safety contract: `succeededIds` reports EXACTLY the ids
 * whose task succeeded, because the caller subtracts those (and only those)
 * from the live selection. Over-reporting would deselect failed ids the user
 * wants to retry; the old whole-selection reset silently discarded picks made
 * while the fan-out was in flight.
 */

import { runBounded, BULK_CONCURRENCY } from "@/lib/atrium/bulk-run";

const ok = async (): Promise<{ isSuccess: boolean; message?: string }> => ({
  isSuccess: true,
});

describe("runBounded", () => {
  it("reports every id on full success, and counts match", async () => {
    const ids = ["a", "b", "c"];
    const { outcome, succeededIds } = await runBounded(ids, ok);
    expect(outcome.succeeded).toBe(3);
    expect(outcome.failures.size).toBe(0);
    expect([...succeededIds].sort()).toEqual(["a", "b", "c"]);
  });

  it("reports ONLY the succeeded ids on partial failure, aggregating failure messages", async () => {
    const { outcome, succeededIds } = await runBounded(
      ["draft-1", "published-1", "draft-2", "published-2"],
      async (id) =>
        id.startsWith("published")
          ? { isSuccess: false, message: "Published items cannot be deleted" }
          : { isSuccess: true }
    );
    expect([...succeededIds].sort()).toEqual(["draft-1", "draft-2"]);
    expect(outcome.succeeded).toBe(2);
    // Identical failure messages aggregate into one entry with a count.
    expect(outcome.failures.get("Published items cannot be deleted")).toBe(2);
  });

  it("records a thrown task as a failure (never rejects) and surfaces it to onTaskError", async () => {
    const seen: Array<[string, unknown]> = [];
    const boom = new Error("network down");
    const { outcome, succeededIds } = await runBounded(
      ["a", "b"],
      async (id) => {
        if (id === "b") throw boom;
        return { isSuccess: true };
      },
      (id, e) => seen.push([id, e])
    );
    expect(succeededIds).toEqual(["a"]);
    expect(outcome.succeeded).toBe(1);
    expect(outcome.failures.get("Request failed — please try again")).toBe(1);
    expect(seen).toEqual([["b", boom]]);
  });

  it(`never runs more than ${BULK_CONCURRENCY} tasks concurrently`, async () => {
    let inFlight = 0;
    let peak = 0;
    const ids = Array.from({ length: 12 }, (_, i) => `id-${i}`);
    await runBounded(ids, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { isSuccess: true };
    });
    expect(peak).toBeLessThanOrEqual(BULK_CONCURRENCY);
    expect(peak).toBeGreaterThan(1); // sanity: it actually ran concurrently
  });
});
