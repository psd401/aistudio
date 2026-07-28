/** @jest-environment node */

import {
  CONTENT_PLATFORM_METRIC_UNITS,
  contentPlatformMetricValues,
} from "@/lib/repositories/content-platform/operational-metrics";

describe("unified content operational metrics", () => {
  it("maps every dashboard signal to one finite metric value", () => {
    const metrics = contentPlatformMetricValues({
      connectorFailures: 1,
      estimatedCostUsd: 2.5,
      failedJobs: 3,
      migrationFailed: 4,
      migrationMismatches: 5,
      migrationUnrecoverable: 6,
      migrationVerified: 7,
      pendingJobs: 8,
      retrievalOverlapRatio: 0.75,
      retrievalShadowObservations: 9,
      staleRepositories: 10,
    });
    expect(Object.keys(metrics).sort()).toEqual(
      Object.keys(CONTENT_PLATFORM_METRIC_UNITS).sort(),
    );
    expect(metrics.RetrievalOverlapRatio24h).toBe(0.75);
    expect(Object.values(metrics).every(Number.isFinite)).toBe(true);
  });
});
