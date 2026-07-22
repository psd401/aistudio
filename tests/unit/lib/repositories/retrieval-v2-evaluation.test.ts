/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";
import {
  evaluateRetrievalCorpus,
  retrievalQualityFailures,
  type RetrievalEvaluationCase,
  type RetrievalQualityThresholds,
} from "@/lib/repositories/retrieval-v2/evaluation";

const thresholds: RetrievalQualityThresholds = {
  minimumRecallAtK: 0.9,
  minimumMeanReciprocalRank: 0.75,
  minimumNdcgAtK: 0.8,
  minimumCitationValidityRate: 1,
  maximumUnauthorizedHits: 0,
  maximumP95LatencyMs: 500,
  maximumAverageCostUsd: 0.001,
};

describe("retrieval v2 offline quality gate", () => {
  it("meets recall, ranking, citation, leakage, latency, and cost budgets", () => {
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "tests/fixtures/retrieval-v2/golden.json"),
        "utf8",
      ),
    ) as RetrievalEvaluationCase[];
    const report = evaluateRetrievalCorpus(fixture, 5);

    expect(retrievalQualityFailures(report, thresholds)).toEqual([]);
    expect(report).toMatchObject({
      cases: 3,
      recallAtK: 1,
      citationValidityRate: 1,
      unauthorizedHits: 0,
      p95LatencyMs: 440,
    });
    expect(report.averageEstimatedCostUsd).toBeCloseTo(0.0008, 8);
  });

  it("names every breached security and quality budget", () => {
    const report = evaluateRetrievalCorpus(
      [
        {
          id: "regression",
          relevantChunkIds: [1],
          returned: [
            { chunkId: 9, authorized: false, citationValid: false },
          ],
          latencyMs: 5_000,
          estimatedCostUsd: 1,
        },
      ],
      5,
    );

    expect(retrievalQualityFailures(report, thresholds)).toEqual([
      "recall@k",
      "mean reciprocal rank",
      "nDCG@k",
      "citation validity",
      "authorization leakage",
      "p95 latency",
      "average cost",
    ]);
  });
});
