/** @jest-environment node */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const publicationSource = readFileSync(
  resolve(
    process.cwd(),
    "lib/repositories/content-platform/publication-service.ts",
  ),
  "utf8",
);
const workerSource = readFileSync(
  resolve(
    process.cwd(),
    "infra/lambdas/unified-content-processor/index.ts",
  ),
  "utf8",
);

describe("unified content publication replay integrity", () => {
  it("binds an existing artifact replay to immutable payload coordinates", () => {
    expect(publicationSource).toContain(
      "assertCanonicalArtifactReplayBinding",
    );
    expect(publicationSource).toContain(
      "artifact.itemVersionId !== input.itemVersionId",
    );
    expect(publicationSource).toContain(
      "artifact.objectKey !== (input.canonicalTextObjectKey ?? null)",
    );
    expect(publicationSource).toContain(
      "artifact.textInline !== (input.canonicalText ?? null)",
    );
    expect(publicationSource).toContain(
      "storedSha256 !== canonicalTextSha256",
    );
  });

  it("has S3 verify the object-backed canonical-text digest", () => {
    expect(workerSource).toContain(
      'ChecksumSHA256: Buffer.from(canonicalTextSha256, "hex").toString(',
    );
  });
});
