/** @jest-environment node */

import {
  buildRepositorySourceObjectKey,
  isRepositorySourceObjectKey,
} from "@/lib/repositories/content-platform/object-key";

describe("repository source object key contract", () => {
  const sourceId = "11111111-2222-4333-8444-555555555555";

  it("builds the exact two-segment namespace accepted by the processor", () => {
    const key = buildRepositorySourceObjectKey(7, "handbook.pdf", sourceId);

    expect(key).toBe(`repositories/7/${sourceId}/handbook.pdf`);
    expect(isRepositorySourceObjectKey(7, key)).toBe(true);
  });

  it("rejects cross-repository, legacy nested, artifact, and traversal keys", () => {
    expect(
      isRepositorySourceObjectKey(8, `repositories/7/${sourceId}/handbook.pdf`)
    ).toBe(false);
    expect(
      isRepositorySourceObjectKey(
        7,
        `repositories/7/inline/${sourceId}/handbook.pdf`
      )
    ).toBe(false);
    expect(
      isRepositorySourceObjectKey(
        7,
        `repositories/7/artifacts/${sourceId}/canonical.md`
      )
    ).toBe(false);
    expect(
      isRepositorySourceObjectKey(7, `repositories/7/${sourceId}/../secret.pdf`)
    ).toBe(false);
  });

  it("refuses unsafe file names before creating an S3 key", () => {
    expect(() =>
      buildRepositorySourceObjectKey(7, "../secret.pdf", sourceId)
    ).toThrow("safe file name");
    expect(() =>
      buildRepositorySourceObjectKey(7, "folder/secret.pdf", sourceId)
    ).toThrow("safe file name");
  });
});
