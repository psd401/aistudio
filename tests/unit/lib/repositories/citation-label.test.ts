/** @jest-environment node */

import { formatRepositorySourceLocator } from "@/lib/repositories/citation-label";

describe("repository citation labels", () => {
  it.each([
    [{ page: 3, pageEnd: 5 }, "Pages 3–5"],
    [{ paragraph: 2 }, "Paragraph 2"],
    [{ slide: 4 }, "Slide 4"],
    [{ sheet: "Directory", cellRange: "A1:B2" }, "Directory!A1:B2"],
    [{ headingPath: ["Policy", "Exceptions"] }, "Policy › Exceptions"],
    [{ timeStartMs: 12_000, timeEndMs: 18_000 }, "12s–18s"],
  ])("formats %p", (locator, expected) => {
    expect(formatRepositorySourceLocator(locator)).toBe(expected);
  });

  it("returns null when a segment has no displayable locator", () => {
    expect(formatRepositorySourceLocator({})).toBeNull();
  });
});
