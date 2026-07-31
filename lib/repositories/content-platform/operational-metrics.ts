import { sql } from "drizzle-orm";
import { executeQuery, toPgRows } from "@/lib/db/drizzle-client";

export interface ContentPlatformOperationalSnapshot {
  activeRepositoriesWithoutSearchableContent: number;
  agenticReadyModels: number;
  conversationRepositoryBindingRate: number;
  connectorFailures: number;
  connectorRevocations24h: number;
  estimatedCostUsd: number;
  failedJobs: number;
  migrationFailed: number;
  migrationMismatches: number;
  migrationUnrecoverable: number;
  migrationVerified: number;
  pendingJobs: number;
  retrievalOverlapRatio: number;
  retrievalShadowObservations: number;
  retrievalZeroResultRatio: number;
  failedGenerations: number;
  stalledBuildingGenerations: number;
  staleRepositories: number;
  unavailableItems: number;
}

interface OperationalSnapshotRow {
  active_repositories_without_searchable_content: number | string;
  agentic_ready_models: number | string;
  conversation_repository_binding_rate: number | string;
  connector_failures: number | string;
  connector_revocations_24h: number | string;
  estimated_cost_usd: number | string;
  failed_jobs: number | string;
  migration_failed: number | string;
  migration_mismatches: number | string;
  migration_unrecoverable: number | string;
  migration_verified: number | string;
  pending_jobs: number | string;
  retrieval_overlap_ratio: number | string;
  retrieval_shadow_observations: number | string;
  retrieval_zero_result_ratio: number | string;
  failed_generations: number | string;
  stalled_building_generations: number | string;
  stale_repositories: number | string;
  unavailable_items: number | string;
}

function finiteNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Load one bounded operational snapshot for the unified-content CloudWatch
 * dashboard. All time-series values use the same rolling 24-hour window.
 */
// eslint-disable-next-line complexity, max-lines-per-function -- A single bounded database round trip produces a point-in-time, internally consistent snapshot.
export async function getContentPlatformOperationalSnapshot(): Promise<ContentPlatformOperationalSnapshot> {
  const result = await executeQuery(
    // eslint-disable-next-line max-lines-per-function -- The correlated aggregates intentionally share one snapshot and timestamp.
    (db) =>
      db.execute(sql`
        SELECT
          (
            SELECT COUNT(*)::integer
            FROM repository_items
            WHERE lifecycle_status = 'unavailable'
          ) AS unavailable_items,
          (
            SELECT COUNT(*)::integer
            FROM repository_index_generations
            WHERE status = 'failed'
          ) AS failed_generations,
          (
            SELECT COUNT(*)::integer
            FROM repository_index_generations
            WHERE status = 'building'
              AND created_at < NOW() - INTERVAL '30 minutes'
          ) AS stalled_building_generations,
          (
            SELECT COUNT(*)::integer
            FROM knowledge_repositories repository
            WHERE repository.lifecycle_status = 'active'
              AND repository.repository_kind = 'durable'
              AND NOT EXISTS (
                SELECT 1
                FROM repository_index_generations generation
                JOIN repository_item_chunks chunk
                  ON chunk.index_generation_id = generation.id
                WHERE generation.id = repository.active_index_generation_id
                  AND generation.status = 'active'
              )
          ) AS active_repositories_without_searchable_content,
          (
            SELECT COUNT(*)::integer
            FROM ai_models
            WHERE active = true
              AND architect_enabled = true
              AND agentic_ready = true
          ) AS agentic_ready_models,
          (
            SELECT COALESCE(
              COUNT(DISTINCT binding.conversation_id)::double precision /
                NULLIF(
                  COUNT(DISTINCT conversation.id) FILTER (
                    WHERE binding.conversation_id IS NOT NULL
                      OR conversation.project_id IS NOT NULL
                      OR conversation.skill_id IS NOT NULL
                      OR CASE
                        WHEN jsonb_typeof(
                          COALESCE(conversation.metadata, '{}'::jsonb)
                            -> 'repositoryIds'
                        ) = 'array'
                          THEN jsonb_array_length(
                            COALESCE(conversation.metadata, '{}'::jsonb)
                              -> 'repositoryIds'
                          ) > 0
                        ELSE false
                      END
                  ),
                  0
                ),
              1
            )
            FROM nexus_conversations conversation
            LEFT JOIN nexus_conversation_repositories binding
              ON binding.conversation_id = conversation.id
            WHERE conversation.last_message_at >= NOW() - INTERVAL '24 hours'
          ) AS conversation_repository_binding_rate,
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
            FROM repository_connectors
            WHERE status = 'revoked'
              AND updated_at >= NOW() - INTERVAL '24 hours'
          ) AS connector_revocations_24h,
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
          ) AS retrieval_overlap_ratio,
          (
            SELECT COALESCE(
              COUNT(*) FILTER (WHERE canonical_result_count = 0)::double precision /
                NULLIF(COUNT(*), 0),
              0
            )
            FROM repository_retrieval_shadow_observations
            WHERE created_at >= NOW() - INTERVAL '24 hours'
          ) AS retrieval_zero_result_ratio
      `),
    "contentPlatform.operationalSnapshot",
  );
  const row = toPgRows<OperationalSnapshotRow>(result)[0];
  return {
    activeRepositoriesWithoutSearchableContent: finiteNumber(
      row?.active_repositories_without_searchable_content,
    ),
    agenticReadyModels: finiteNumber(row?.agentic_ready_models),
    conversationRepositoryBindingRate: finiteNumber(
      row?.conversation_repository_binding_rate,
    ),
    connectorFailures: finiteNumber(row?.connector_failures),
    connectorRevocations24h: finiteNumber(row?.connector_revocations_24h),
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
    retrievalZeroResultRatio: finiteNumber(row?.retrieval_zero_result_ratio),
    failedGenerations: finiteNumber(row?.failed_generations),
    stalledBuildingGenerations: finiteNumber(
      row?.stalled_building_generations,
    ),
    staleRepositories: finiteNumber(row?.stale_repositories),
    unavailableItems: finiteNumber(row?.unavailable_items),
  };
}

export const CONTENT_PLATFORM_METRIC_UNITS = {
  ActiveRepositoriesWithoutSearchableContent: "Count",
  AgenticReadyModels: "Count",
  ConversationRepositoryBindingRate24h: "None",
  ConnectorFailures: "Count",
  ConnectorRevocations24h: "Count",
  EstimatedProcessingCostUsd24h: "None",
  FailedJobs24h: "Count",
  MigrationFailed: "Count",
  MigrationMismatches: "Count",
  MigrationUnrecoverable: "Count",
  MigrationVerified: "Count",
  PendingJobs: "Count",
  RetrievalOverlapRatio24h: "None",
  RetrievalShadowObservations24h: "Count",
  RetrievalZeroResultRatio24h: "None",
  FailedGenerations: "Count",
  StalledBuildingGenerations: "Count",
  StaleRepositories: "Count",
  UnavailableItems: "Count",
} as const;

export function contentPlatformMetricValues(
  snapshot: ContentPlatformOperationalSnapshot,
): Record<keyof typeof CONTENT_PLATFORM_METRIC_UNITS, number> {
  return {
    ActiveRepositoriesWithoutSearchableContent:
      snapshot.activeRepositoriesWithoutSearchableContent,
    AgenticReadyModels: snapshot.agenticReadyModels,
    ConversationRepositoryBindingRate24h:
      snapshot.conversationRepositoryBindingRate,
    ConnectorFailures: snapshot.connectorFailures,
    ConnectorRevocations24h: snapshot.connectorRevocations24h,
    EstimatedProcessingCostUsd24h: snapshot.estimatedCostUsd,
    FailedJobs24h: snapshot.failedJobs,
    MigrationFailed: snapshot.migrationFailed,
    MigrationMismatches: snapshot.migrationMismatches,
    MigrationUnrecoverable: snapshot.migrationUnrecoverable,
    MigrationVerified: snapshot.migrationVerified,
    PendingJobs: snapshot.pendingJobs,
    RetrievalOverlapRatio24h: snapshot.retrievalOverlapRatio,
    RetrievalShadowObservations24h: snapshot.retrievalShadowObservations,
    RetrievalZeroResultRatio24h: snapshot.retrievalZeroResultRatio,
    FailedGenerations: snapshot.failedGenerations,
    StalledBuildingGenerations: snapshot.stalledBuildingGenerations,
    StaleRepositories: snapshot.staleRepositories,
    UnavailableItems: snapshot.unavailableItems,
  };
}
