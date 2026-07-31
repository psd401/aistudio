/** @jest-environment node */

import {
  CONTENT_PLATFORM_METRIC_UNITS,
  contentPlatformMetricValues,
} from "@/lib/repositories/content-platform/operational-metrics";

describe("unified content operational metrics", () => {
  it("maps every dashboard signal to one finite metric value", () => {
    const metrics = contentPlatformMetricValues({
      activeRepositoriesWithoutSearchableContent: 1,
      agenticReadyModels: 2,
      conversationRepositoryBindingRate: 0.5,
      connectorFailures: 1,
      connectorRevocations24h: 2,
      estimatedCostUsd: 2.5,
      failedJobs: 3,
      migrationFailed: 4,
      migrationMismatches: 5,
      migrationUnrecoverable: 6,
      migrationVerified: 7,
      pendingJobs: 8,
      retrievalOverlapRatio: 0.75,
      retrievalShadowObservations: 9,
      retrievalZeroResultRatio: 0.25,
      failedGenerations: 2,
      stalledBuildingGenerations: 3,
      staleRepositories: 10,
      unavailableItems: 4,
    });
    expect(Object.keys(metrics).sort()).toEqual(
      Object.keys(CONTENT_PLATFORM_METRIC_UNITS).sort(),
    );
    expect(metrics.RetrievalOverlapRatio24h).toBe(0.75);
    expect(Object.values(metrics).every(Number.isFinite)).toBe(true);
  });
});
