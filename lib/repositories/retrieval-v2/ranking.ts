import type { RetrievalCandidate } from "./types";

export interface RankedCandidateList {
  signal: "dense" | "lexical" | "visual";
  candidates: RetrievalCandidate[];
  weight?: number;
}

/** Reciprocal-rank fusion is stable across incomparable provider score scales. */
export function reciprocalRankFusion(
  lists: RankedCandidateList[],
  smoothingConstant: number
): RetrievalCandidate[] {
  if (!Number.isSafeInteger(smoothingConstant) || smoothingConstant < 1) {
    throw new Error("RRF smoothing constant must be a positive integer");
  }
  const fused = new Map<number, RetrievalCandidate>();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.candidates.forEach((candidate, index) => {
      const existing = fused.get(candidate.chunkId) ?? {
        ...candidate,
        fusedScore: 0,
      };
      existing.fusedScore += weight / (smoothingConstant + index + 1);
      const rawScore =
        list.signal === "dense"
          ? candidate.denseScore
          : list.signal === "lexical"
            ? candidate.lexicalScore
            : candidate.visualScore;
      if (rawScore != null) existing[`${list.signal}Score`] = rawScore;
      fused.set(candidate.chunkId, existing);
    });
  }
  return [...fused.values()].sort(
    (left, right) =>
      right.fusedScore - left.fusedScore || left.chunkId - right.chunkId
  );
}

export function diversifyBySource(
  candidates: RetrievalCandidate[],
  limit: number,
  maximumPerSource: number
): RetrievalCandidate[] {
  const selected: RetrievalCandidate[] = [];
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = `${candidate.repositoryId}:${candidate.itemVersionId}`;
    const count = counts.get(key) ?? 0;
    if (count >= maximumPerSource) continue;
    selected.push(candidate);
    counts.set(key, count + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

export function applyRerankScores(
  candidates: RetrievalCandidate[],
  scores: Array<{ index: number; score: number }>
): RetrievalCandidate[] {
  const scoresByIndex = new Map<number, number>();
  for (const { index, score } of scores) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= candidates.length ||
      !Number.isFinite(score)
    ) {
      continue;
    }
    scoresByIndex.set(index, Math.max(score, scoresByIndex.get(index) ?? -Infinity));
  }

  return candidates
    .map((candidate, index) => {
      const score = scoresByIndex.get(index);
      return score == null ? candidate : { ...candidate, rerankScore: score };
    })
    .sort((left, right) => {
      if (left.rerankScore != null && right.rerankScore != null) {
        return (
          right.rerankScore - left.rerankScore ||
          right.fusedScore - left.fusedScore
        );
      }
      if (left.rerankScore != null) return -1;
      if (right.rerankScore != null) return 1;
      return right.fusedScore - left.fusedScore;
    });
}
