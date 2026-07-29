/**
 * Unit tests for the library bulk-action summary sentence (#1336).
 *
 * The bulk bar fans out single-id server actions and folds every outcome into
 * ONE message, so this function is the entire user-facing report for a mixed
 * result. Its three branches are easy to get subtly wrong and only one of them
 * (the mixed case) is reachable from the e2e spec, which is how
 * `Could not deleted 2 items` shipped in the first cut.
 */

import { summarize, type BulkOutcome } from "@/lib/atrium/bulk-summary";

const outcome = (
  succeeded: number,
  failures: Array<[string, number]> = []
): BulkOutcome => ({ succeeded, failures: new Map(failures) });

describe("summarize()", () => {
  it("reports a clean all-succeeded run in the past tense", () => {
    expect(summarize(outcome(3), "Archived", 3)).toBe("Archived 3 items.");
  });

  it("singularises a one-item success", () => {
    expect(summarize(outcome(1), "Deleted", 1)).toBe("Deleted 1 item.");
  });

  it("reports a mixed result with the counts and the reasons", () => {
    const res = summarize(
      outcome(1, [["Published content cannot be deleted", 1]]),
      "Deleted",
      2
    );
    expect(res).toBe(
      "Deleted 1 of 2. 1 failed: Published content cannot be deleted"
    );
  });

  it("uses the INFINITIVE when everything failed (not the past tense)", () => {
    // Regression: this branch lowercased the past-tense verb, producing
    // "Could not deleted 2 items".
    expect(summarize(outcome(0, [["Refused", 2]]), "Deleted", 2)).toBe(
      "Could not delete 2 items: Refused (×2)"
    );
    expect(summarize(outcome(0, [["Refused", 1]]), "Archived", 1)).toBe(
      "Could not archive 1 item: Refused"
    );
    expect(summarize(outcome(0, [["Refused", 1]]), "Restored", 1)).toBe(
      "Could not restore 1 item: Refused"
    );
    expect(summarize(outcome(0, [["Refused", 1]]), "Moved", 1)).toBe(
      "Could not move 1 item: Refused"
    );
  });

  it("falls back readably for an unmapped verb rather than printing undefined", () => {
    expect(summarize(outcome(0, [["Refused", 1]]), "Frobbed", 1)).toBe(
      "Could not frobbed 1 item: Refused"
    );
  });

  it("dedupes identical reasons with a count, and lists distinct ones", () => {
    const res = summarize(
      outcome(0, [
        ["Refused", 2],
        ["Not found", 1],
      ]),
      "Deleted",
      3
    );
    expect(res).toBe("Could not delete 3 items: Refused (×2); Not found");
  });
});
