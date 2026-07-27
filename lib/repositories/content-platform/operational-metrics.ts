import { sql } from "drizzle-orm";
import { executeQuery, toPgRows } from "@/lib/db/drizzle-client";

export interface ContentPlatformOperationalSnapshot {
  connectorFailures: number;
  estimatedCostUsd: number;
  failedJobs: number;
  migrationFailed: number;
  migrationMismatches: number;
  migrationUnrecoverable: number;
  migrationVerified: number;
  pendingJobs: number;
  retrievalOverlapRatio: number;
  retrievalShadowObservations: number;
  staleRepositories: number;
}

interface OperationalSnapshotRow {
  connector_failures: number | string;
  estimated_cost_usd: number | string;
  failed_jobs: number | string;
  migration_failed: number | string;
  migration_mismatches: number | string;
  migration_unrecoverable: number | string;
  migration_verified: number | string;
  pending_jobs: number | string;
  retrieval_overlap_ratio: number | string;
  retrieval_shadow_observations: number | string;
  stale_repositories: number | string;
}

function finiteNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Load one bounded operational snapshot for the unified-content CloudWatch
 * dashboard. All time-series values use the same rolling 24-hour window.
 */
export async function getContentPlatformOperationalSnapshot(): Promise<ContentPlatformOperationalSnapshot> {
  const result = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT
          (
            SELECT COUNT(*)::integer
            FROM repository_processing_jobs
            WHERE status IN ('pending', 'queued', 'running')
          ) AS pending_jobs,
          (
            SELECT COUNT(*)::integer
            FROM repository_processing_jobs
            WHERE status = 'failed'
              AND updated_at >= NOW() - INTERVAL '24 hours'
          ) AS failed_jobs,
          (
            SELECT COALESCE(
              SUM(
                CASE
                  WHEN jsonb_typeof(metrics->'estimatedCostUsd') = 'number'
                  THEN (metrics->>'estimatedCostUsd')::numeric
                  ELSE 0
                END
              ),
              0
            )
            FROM repository_processing_jobs
            WHERE updated_at >= NOW() - INTERVAL '24 hours'
          ) AS estimated_cost_usd,
          (
            SELECT COUNT(*)::integer
            FROM knowledge_repositories repository
            WHERE repository.lifecycle_status = 'active'
              AND EXISTS (
                SELECT 1
                FROM repository_items item
                WHERE item.repository_id = repository.id
                  AND item.current_version_id IS NOT NULL
                  AND item.lifecycle_status = 'active'
              )
              AND (
                repository.active_index_generation_id IS NULL
                OR NOT EXISTS (
                  SELECT 1
                  FROM repository_index_generations generation
                  WHERE generation.id = repository.active_index_generation_id
                    AND generation.status = 'active'
                )
              )
          ) AS stale_repositories,
          (
            SELECT COUNT(*)::integer
            FROM repository_connectors
            WHERE status = 'degraded'
               OR consecutive_failures > 0
          ) AS connector_failures,
          (
            SELECT COUNT(*)::integer
            FROM repository_migration_items
            WHERE status = 'failed'
          ) AS migration_failed,
          (
            SELECT COUNT(*)::integer
            FROM repository_migration_items
            WHERE status = 'unrecoverable'
          ) AS migration_unrecoverable,
          (
            SELECT COUNT(*)::integer
            FROM repository_migration_items
            WHERE status = 'mismatch'
          ) AS migration_mismatches,
          (
            SELECT COUNT(*)::integer
            FROM repository_migration_items
            WHERE status = 'verified'
          ) AS migration_verified,
          (
            SELECT COUNT(*)::integer
            FROM repository_retrieval_shadow_observations
            WHERE created_at >= NOW() - INTERVAL '24 hours'
          ) AS retrieval_shadow_observations,
          (
            SELECT COALESCE(
              SUM(overlapping_item_count)::double precision /
                NULLIF(
                  SUM(GREATEST(legacy_result_count, canonical_result_count)),
                  0
                ),
              0
            )
            FROM repository_retrieval_shadow_observations
            WHERE created_at >= NOW() - INTERVAL '24 hours'
          ) AS retrieval_overlap_ratio
      `),
    "contentPlatform.operationalSnapshot",
  );
  const row = toPgRows<OperationalSnapshotRow>(result)[0];
  return {
    connectorFailures: finiteNumber(row?.connector_failures),
    estimatedCostUsd: finiteNumber(row?.estimated_cost_usd),
    failedJobs: finiteNumber(row?.failed_jobs),
    migrationFailed: finiteNumber(row?.migration_failed),
    migrationMismatches: finiteNumber(row?.migration_mismatches),
    migrationUnrecoverable: finiteNumber(row?.migration_unrecoverable),
    migrationVerified: finiteNumber(row?.migration_verified),
    pendingJobs: finiteNumber(row?.pending_jobs),
    retrievalOverlapRatio: finiteNumber(row?.retrieval_overlap_ratio),
    retrievalShadowObservations: finiteNumber(
      row?.retrieval_shadow_observations,
    ),
    staleRepositories: finiteNumber(row?.stale_repositories),
  };
}

export const CONTENT_PLATFORM_METRIC_UNITS = {
  ConnectorFailures: "Count",
  EstimatedProcessingCostUsd24h: "None",
  FailedJobs24h: "Count",
  MigrationFailed: "Count",
  MigrationMismatches: "Count",
  MigrationUnrecoverable: "Count",
  MigrationVerified: "Count",
  PendingJobs: "Count",
  RetrievalOverlapRatio24h: "None",
  RetrievalShadowObservations24h: "Count",
  StaleRepositories: "Count",
} as const;

export function contentPlatformMetricValues(
  snapshot: ContentPlatformOperationalSnapshot,
): Record<keyof typeof CONTENT_PLATFORM_METRIC_UNITS, number> {
  return {
    ConnectorFailures: snapshot.connectorFailures,
    EstimatedProcessingCostUsd24h: snapshot.estimatedCostUsd,
    FailedJobs24h: snapshot.failedJobs,
    MigrationFailed: snapshot.migrationFailed,
    MigrationMismatches: snapshot.migrationMismatches,
    MigrationUnrecoverable: snapshot.migrationUnrecoverable,
    MigrationVerified: snapshot.migrationVerified,
    PendingJobs: snapshot.pendingJobs,
    RetrievalOverlapRatio24h: snapshot.retrievalOverlapRatio,
    RetrievalShadowObservations24h: snapshot.retrievalShadowObservations,
    StaleRepositories: snapshot.staleRepositories,
  };
}
