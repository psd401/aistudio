/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";
import {
  CONTENT_PLATFORM_METRIC_UNITS,
  contentPlatformMetricValues,
} from "@/lib/repositories/content-platform/operational-metrics";

const operationalMetricsSource = fs.readFileSync(
  path.join(
    process.cwd(),
    "lib/repositories/content-platform/operational-metrics.ts",
  ),
  "utf8",
);

describe("unified content operational metrics", () => {
  it("maps every dashboard signal to one finite metric value", () => {
    const metrics = contentPlatformMetricValues({
      activeRepositoriesWithoutSearchableContent: 1,
      agenticReadyModels: 2,
      conversationRepositoryBindingRate: 0.5,
      connectorFailures: 1,
      connectorRevocations24h: 2,
      chunksMissingEmbeddings: 12,
      estimatedCostUsd: 2.5,
      failedJobs: 3,
      migrationFailed: 4,
      migrationMismatches: 5,
      migrationUnrecoverable: 6,
      migrationVerified: 7,
      orphanedItems: 11,
      itemsSearchableWithoutEmbeddings: 13,
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

  it("includes generation-less legacy chunks in embedding health", () => {
    expect(
      operationalMetricsSource.match(
        /LEFT JOIN repository_index_generations generation/g,
      ),
    ).toHaveLength(2);
    expect(
      operationalMetricsSource.match(/repository\.id = item\.repository_id/g),
    ).toHaveLength(3);
    expect(
      operationalMetricsSource.match(/chunk\.index_generation_id IS NULL/g),
    ).toHaveLength(2);
  });
});
