/** @jest-environment node */

import {
  countRepositoryTokens,
  splitTokenizerAwareText,
  truncateToRepositoryTokens,
} from "@/lib/repositories/content-platform/token-segmentation";

describe("repository token segmentation", () => {
  it("enforces token ceilings and deterministic overlap", () => {
    const input = Array.from(
      { length: 260 },
      (_, index) => `Sentence ${index} describes a district procedure.`,
    ).join(" ");
    const first = splitTokenizerAwareText(input, {
      maximumTokens: 96,
      overlapTokens: 16,
    });
    const second = splitTokenizerAwareText(input, {
      maximumTokens: 96,
      overlapTokens: 16,
    });

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(2);
    expect(first.every((segment) => countRepositoryTokens(segment) <= 96)).toBe(
      true,
    );
    expect(first.slice(1).every((segment) => segment.includes("Sentence"))).toBe(
      true,
    );
  });

  it("truncates content using the same tokenizer budget", () => {
    const input = "policy ".repeat(500);
    const truncated = truncateToRepositoryTokens(input, 40);
    expect(countRepositoryTokens(truncated)).toBeLessThanOrEqual(40);
    expect(truncated.length).toBeLessThan(input.length);
  });

  it("rejects unsafe segmentation options", () => {
    expect(() =>
      splitTokenizerAwareText("content", {
        maximumTokens: 63,
        overlapTokens: 1,
      }),
    ).toThrow("at least 64");
    expect(() =>
      splitTokenizerAwareText("content", {
        maximumTokens: 64,
        overlapTokens: 64,
      }),
    ).toThrow("smaller than maximumTokens");
  });
});
