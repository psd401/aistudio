/** @jest-environment node */

import {
  applyRerankScores,
  diversifyBySource,
  reciprocalRankFusion,
} from "@/lib/repositories/retrieval-v2/ranking";
import type { RetrievalCandidate } from "@/lib/repositories/retrieval-v2/types";

function candidate(
  chunkId: number,
  itemVersionId = `version-${chunkId}`,
): RetrievalCandidate {
  return {
    chunkId,
    repositoryId: 1,
    repositoryName: "Policies",
    generationId: "generation",
    itemId: chunkId,
    itemStableId: `item-${chunkId}`,
    itemName: `Policy ${chunkId}`,
    itemVersionId,
    versionNumber: 1,
    artifactId: null,
    content: `content ${chunkId}`,
    contextPrefix: "Page 1",
    chunkIndex: chunkId,
    parentChunkIndex: null,
    segmentLevel: "chunk",
    modality: "text",
    sourceLocator: { page: 1 },
    tokens: 5,
    metadata: {},
    fusedScore: 0,
  };
}

describe("retrieval v2 ranking", () => {
  it("fuses incomparable signal rankings with deterministic weighted RRF", () => {
    const denseFirst = { ...candidate(1), denseScore: 0.95 };
    const lexicalFirst = { ...candidate(2), lexicalScore: 0.8 };
    const fused = reciprocalRankFusion(
      [
        { signal: "dense", candidates: [denseFirst, candidate(2)], weight: 0.7 },
        {
          signal: "lexical",
          candidates: [lexicalFirst, candidate(1)],
          weight: 0.3,
        },
      ],
      60,
    );

    expect(fused.map((entry) => entry.chunkId)).toEqual([1, 2]);
    expect(fused[0]).toMatchObject({ denseScore: 0.95 });
    expect(fused[1]).toMatchObject({ lexicalScore: 0.8 });
  });

  it("applies provider rerank indices and ignores invalid result indices", () => {
    const ranked = applyRerankScores(
      [candidate(1), candidate(2)],
      [
        { index: 1, score: 0.99 },
        { index: 4, score: 1 },
        { index: 0, score: 0.25 },
      ],
    );
    expect(ranked.map((entry) => entry.chunkId)).toEqual([2, 1]);
    expect(ranked).toHaveLength(2);
  });

  it("preserves fused candidates when the reranker returns a partial response", () => {
    const first = { ...candidate(1), fusedScore: 0.04 };
    const second = { ...candidate(2), fusedScore: 0.03 };
    const third = { ...candidate(3), fusedScore: 0.02 };

    const ranked = applyRerankScores(
      [first, second, third],
      [{ index: 2, score: 0.9 }],
    );

    expect(ranked.map((entry) => entry.chunkId)).toEqual([3, 1, 2]);
    expect(ranked).toHaveLength(3);
  });

  it("caps results from one source without discarding other sources", () => {
    const diversified = diversifyBySource(
      [candidate(1, "same"), candidate(2, "same"), candidate(3, "other")],
      3,
      1,
    );
    expect(diversified.map((entry) => entry.chunkId)).toEqual([1, 3]);
  });
});
