/** @jest-environment node */

import { overlappingMigrationItemCount } from "@/lib/repositories/content-platform/retrieval-shadow";

describe("repository retrieval shadow", () => {
  it("counts unique overlapping result items", () => {
    expect(overlappingMigrationItemCount([1, 1, 2, 3], [2, 3, 3, 4])).toBe(2);
  });
});
