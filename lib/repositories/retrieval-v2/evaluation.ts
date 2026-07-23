export interface RetrievalEvaluationHit {
  chunkId: number;
  authorized: boolean;
  citationValid: boolean;
}

export interface RetrievalEvaluationCase {
  id: string;
  relevantChunkIds: number[];
  returned: RetrievalEvaluationHit[];
  latencyMs: number;
  estimatedCostUsd: number;
}

export interface RetrievalEvaluationReport {
  cases: number;
  recallAtK: number;
  meanReciprocalRank: number;
  ndcgAtK: number;
  citationValidityRate: number;
  unauthorizedHits: number;
  p95LatencyMs: number;
  totalEstimatedCostUsd: number;
  averageEstimatedCostUsd: number;
}

export interface RetrievalQualityThresholds {
  minimumRecallAtK: number;
  minimumMeanReciprocalRank: number;
  minimumNdcgAtK: number;
  minimumCitationValidityRate: number;
  maximumUnauthorizedHits: number;
  maximumP95LatencyMs: number;
  maximumAverageCostUsd: number;
}

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function discountedGain(relevance: number, rank: number): number {
  return relevance / Math.log2(rank + 2);
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

/** Evaluate a checked-in or captured retrieval corpus without provider calls. */
export function evaluateRetrievalCorpus(
  cases: RetrievalEvaluationCase[],
  k = 10,
): RetrievalEvaluationReport {
  if (!Number.isSafeInteger(k) || k < 1) {
    throw new Error("Retrieval evaluation k must be a positive integer");
  }
  const recalls: number[] = [];
  const reciprocalRanks: number[] = [];
  const normalizedGains: number[] = [];
  let citationHits = 0;
  let validCitations = 0;
  let unauthorizedHits = 0;

  for (const evaluationCase of cases) {
    const relevant = new Set(evaluationCase.relevantChunkIds);
    const returned = evaluationCase.returned.slice(0, k);
    const relevantReturned = returned.filter((hit) => relevant.has(hit.chunkId));
    recalls.push(
      relevant.size === 0 ? 1 : relevantReturned.length / relevant.size,
    );
    const firstRelevantRank = returned.findIndex((hit) => relevant.has(hit.chunkId));
    reciprocalRanks.push(
      firstRelevantRank < 0 ? 0 : 1 / (firstRelevantRank + 1),
    );
    const actualGain = returned.reduce(
      (total, hit, index) =>
        total + discountedGain(relevant.has(hit.chunkId) ? 1 : 0, index),
      0,
    );
    const idealRelevantCount = Math.min(relevant.size, k);
    const idealGain = Array.from(
      { length: idealRelevantCount },
      (_, index) => discountedGain(1, index),
    ).reduce((total, value) => total + value, 0);
    normalizedGains.push(idealGain === 0 ? 1 : actualGain / idealGain);
    citationHits += returned.length;
    validCitations += returned.filter((hit) => hit.citationValid).length;
    unauthorizedHits += returned.filter((hit) => !hit.authorized).length;
  }

  const totalEstimatedCostUsd = cases.reduce(
    (total, entry) => total + entry.estimatedCostUsd,
    0,
  );
  return {
    cases: cases.length,
    recallAtK: average(recalls),
    meanReciprocalRank: average(reciprocalRanks),
    ndcgAtK: average(normalizedGains),
    citationValidityRate: citationHits === 0 ? 1 : validCitations / citationHits,
    unauthorizedHits,
    p95LatencyMs: percentile95(cases.map((entry) => entry.latencyMs)),
    totalEstimatedCostUsd,
    averageEstimatedCostUsd:
      cases.length === 0 ? 0 : totalEstimatedCostUsd / cases.length,
  };
}

export function retrievalQualityFailures(
  report: RetrievalEvaluationReport,
  thresholds: RetrievalQualityThresholds,
): string[] {
  const failures: string[] = [];
  if (report.recallAtK < thresholds.minimumRecallAtK) failures.push("recall@k");
  if (report.meanReciprocalRank < thresholds.minimumMeanReciprocalRank) {
    failures.push("mean reciprocal rank");
  }
  if (report.ndcgAtK < thresholds.minimumNdcgAtK) failures.push("nDCG@k");
  if (report.citationValidityRate < thresholds.minimumCitationValidityRate) {
    failures.push("citation validity");
  }
  if (report.unauthorizedHits > thresholds.maximumUnauthorizedHits) {
    failures.push("authorization leakage");
  }
  if (report.p95LatencyMs > thresholds.maximumP95LatencyMs) {
    failures.push("p95 latency");
  }
  if (report.averageEstimatedCostUsd > thresholds.maximumAverageCostUsd) {
    failures.push("average cost");
  }
  return failures;
}
