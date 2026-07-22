/** @jest-environment node */

import {
  isValidSourceLocator,
  resolveRetrievalCitation,
} from "@/lib/repositories/retrieval-v2/citations";
import type { RetrievalCandidate } from "@/lib/repositories/retrieval-v2/types";

const baseCandidate: RetrievalCandidate = {
  chunkId: 10,
  repositoryId: 2,
  repositoryName: "Safety",
  generationId: "generation",
  itemId: 3,
  itemStableId: "stable",
  itemName: "Emergency Guide",
  itemVersionId: "version",
  versionNumber: 4,
  artifactId: "artifact",
  content: "Evacuate using the east stairwell.",
  contextPrefix: "Page 7",
  chunkIndex: 5,
  parentChunkIndex: 4,
  segmentLevel: "chunk",
  modality: "text",
  sourceLocator: { page: 7 },
  tokens: 8,
  metadata: {},
  fusedScore: 0.1,
};

describe("retrieval v2 exact citations", () => {
  it("pins citations to the exact immutable item version and locator", () => {
    expect(resolveRetrievalCitation(baseCandidate)).toEqual({
      repositoryId: 2,
      repositoryName: "Safety",
      itemId: 3,
      itemStableId: "stable",
      itemName: "Emergency Guide",
      itemVersionId: "version",
      versionNumber: 4,
      artifactId: "artifact",
      chunkId: 10,
      chunkIndex: 5,
      modality: "text",
      sourceLocator: { page: 7 },
      label: "Page 7",
    });
  });

  it("accepts bounded visual regions and rejects malformed locators", () => {
    expect(
      isValidSourceLocator({
        regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
      }),
    ).toBe(true);
    expect(
      resolveRetrievalCitation({
        ...baseCandidate,
        modality: "image",
        sourceLocator: {
          regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
        },
      }).label,
    ).toBe("Image region");
    expect(isValidSourceLocator({ page: 0 })).toBe(false);
    expect(isValidSourceLocator({ timeStartMs: 10, timeEndMs: 9 })).toBe(false);
    expect(() =>
      resolveRetrievalCitation({ ...baseCandidate, sourceLocator: {} }),
    ).toThrow("no valid source citation");
  });
});
