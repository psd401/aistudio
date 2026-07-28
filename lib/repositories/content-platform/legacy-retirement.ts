import { sql } from "drizzle-orm";
import {
  executeTransaction,
  toPgRows,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import {
  getContentPlatformConfig,
  type ContentPlatformConfig,
} from "./config";
import { assessContentRetirementReadiness } from "./migration-reconciliation";

interface RetirementGateRow {
  active_runs: number | string;
  discovered: number | string;
  dry_runs: number | string;
  failed: number | string;
  migrated: number | string;
  mismatched: number | string;
  recovery_window_ends_at: Date | string | null;
  rollback_drills: number | string;
  uncovered: number | string;
  unrecoverable: number | string;
  verified: number | string;
}

const EMPTY_RETIREMENT_GATE: RetirementGateRow = {
  active_runs: 0,
  discovered: 0,
  dry_runs: 0,
  failed: 0,
  migrated: 0,
  mismatched: 0,
  recovery_window_ends_at: null,
  rollback_drills: 0,
  uncovered: 0,
  unrecoverable: 0,
  verified: 0,
};

const EXCLUDE_NON_MIGRATABLE_REPOSITORY_ITEMS = sql`
  AND NOT (COALESCE(item.metadata, '{}'::jsonb) ? 'migrationSourceKind')
  AND NOT EXISTS (
    SELECT 1
    FROM repository_connector_sources connector_source
    WHERE connector_source.repository_item_id = item.id
      AND connector_source.status = 'unsupported'
  )
`;

function count(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRetirementGateReady(
  config: ContentPlatformConfig,
  row: RetirementGateRow | undefined,
): boolean {
  const gate = row ?? EMPTY_RETIREMENT_GATE;
  const recoveryWindowEndsAt = gate.recovery_window_ends_at
    ? new Date(gate.recovery_window_ends_at)
    : null;
  return assessContentRetirementReadiness({
    cutoversEnabled: [
      config.enabled,
      config.readV2Enabled,
      config.repositoryCutoverEnabled,
      config.nexusCutoverEnabled,
      config.assistantArchitectCutoverEnabled,
    ].every(Boolean),
    retirementConfigured: config.legacyRetirementEnabled,
    dryRunCompleted: count(gate.dry_runs) > 0,
    inventoryComplete: count(gate.uncovered) === 0,
    activeRunCount: count(gate.active_runs),
    migrationMetrics: {
      discovered: count(gate.discovered),
      migrated: count(gate.migrated),
      verified: count(gate.verified),
      mismatched: count(gate.mismatched),
      failed: count(gate.failed),
      unrecoverable: count(gate.unrecoverable),
    },
    rollbackDrillCompleted: count(gate.rollback_drills) > 0,
    recoveryWindowEndsAt,
  }).ready;
}

async function loadRetirementGateRow(
  tx: DbTransaction,
): Promise<RetirementGateRow | undefined> {
  const result = await tx.execute(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE status IN ('queued', 'running')
        )::integer AS active_runs,
        COUNT(*) FILTER (
          WHERE mode = 'dry_run'
            AND status = 'completed'
            AND source_kinds @> '[
              "repository_item",
              "nexus_document",
              "assistant_pdf_job"
            ]'::jsonb
        )::integer AS dry_runs,
        (
          SELECT COUNT(*)::integer
          FROM repository_migration_items
          WHERE status <> 'excluded'
        ) AS discovered,
        (
          SELECT COUNT(*)::integer
          FROM repository_migration_items
          WHERE status IN ('migrated', 'verified', 'mismatch')
        ) AS migrated,
        (
          SELECT COUNT(*)::integer
          FROM repository_migration_items
          WHERE status = 'verified'
        ) AS verified,
        (
          SELECT COUNT(*)::integer
          FROM repository_migration_items
          WHERE status = 'mismatch'
        ) AS mismatched,
        (
          SELECT COUNT(*)::integer
          FROM repository_migration_items
          WHERE status = 'failed'
        ) AS failed,
        (
          SELECT COUNT(*)::integer
          FROM repository_migration_items
          WHERE status = 'unrecoverable'
        ) AS unrecoverable,
        COUNT(*) FILTER (
          WHERE mode = 'rollback'
            AND status = 'completed'
            AND snapshot->>'rollbackDrill' = 'true'
        )::integer AS rollback_drills,
        GREATEST(
          MAX(recovery_window_ends_at) FILTER (
            WHERE mode = 'backfill'
              AND status IN ('completed', 'completed_with_errors')
          ),
          (
            SELECT MAX(verified_at) + make_interval(
              days => COALESCE((
                SELECT CASE
                  WHEN value ~ '^[0-9]+$'
                    AND value::integer BETWEEN 1 AND 90
                  THEN value::integer
                  ELSE 7
                END
                FROM settings
                WHERE key = 'CONTENT_MIGRATION_RECOVERY_DAYS'
              ), 7)
            )
            FROM repository_migration_items
            WHERE status = 'verified'
          ),
          (
            SELECT (MAX(updated_at) AT TIME ZONE 'UTC') + make_interval(
              days => COALESCE((
                SELECT CASE
                  WHEN value ~ '^[0-9]+$'
                    AND value::integer BETWEEN 1 AND 90
                  THEN value::integer
                  ELSE 7
                END
                FROM settings
                WHERE key = 'CONTENT_MIGRATION_RECOVERY_DAYS'
              ), 7)
            )
            FROM settings
            WHERE key IN (
              'CONTENT_REPOSITORY_CUTOVER_ENABLED',
              'CONTENT_NEXUS_CUTOVER_ENABLED',
              'CONTENT_ASSISTANT_ARCHITECT_CUTOVER_ENABLED'
            )
              AND value = 'true'
          )
        ) AS recovery_window_ends_at,
        (
          SELECT COUNT(*)::integer
          FROM repository_items item
          JOIN knowledge_repositories repository
            ON repository.id = item.repository_id
          WHERE item.lifecycle_status = 'active'
            AND repository.lifecycle_status = 'active'
            AND item.type IN ('document', 'text', 'url')
            ${EXCLUDE_NON_MIGRATABLE_REPOSITORY_ITEMS}
            AND (
              item.current_version_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM repository_item_chunks legacy_chunk
                WHERE legacy_chunk.item_id = item.id
                  AND legacy_chunk.item_version_id IS NULL
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM repository_migration_items migration
              WHERE migration.source_kind = 'repository_item'
                AND migration.source_id = item.id
                AND migration.status = 'verified'
            )
        ) + (
          SELECT COUNT(*)::integer
          FROM documents document
          WHERE NOT EXISTS (
            SELECT 1
            FROM repository_migration_items migration
            WHERE migration.source_kind = 'nexus_document'
              AND migration.source_id = document.id
              AND migration.status = 'verified'
          )
        ) + (
          SELECT COUNT(*)::integer
          FROM jobs job
          WHERE job.type = 'pdf-to-markdown'
            AND NOT EXISTS (
              SELECT 1
              FROM repository_migration_items migration
              WHERE migration.source_kind = 'assistant_pdf_job'
                AND migration.source_id = job.id
                AND migration.status = 'verified'
            )
        ) AS uncovered
      FROM repository_migration_runs
    `);
  const row = toPgRows<RetirementGateRow>(result)[0];
  return row;
}

/**
 * Fail closed on the retirement flag: a legacy route is disabled only after
 * every durable safety gate is true. Before migration 155 is deployed, the
 * absent setting resolves to false and no new-table query is attempted.
 */
export async function isLegacyContentRetirementActive(): Promise<boolean> {
  const config = await getContentPlatformConfig();
  // Migration-first deployment is deliberate. Until the explicit retirement
  // switch is enabled, do not reference any migration-155 relation: an
  // application task can safely start before that additive migration finishes
  // without breaking the still-authoritative legacy endpoints.
  if (!config.legacyRetirementEnabled) return false;

  return executeTransaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('repository-content-migration'))`,
    );
    const [relations] = toPgRows<{
      document_chunks_present: boolean;
      documents_present: boolean;
      migration_items_present: boolean;
      migration_runs_present: boolean;
      retirement_events_present: boolean;
    }>(
      await tx.execute(sql`
        SELECT
          to_regclass('public.document_chunks') IS NOT NULL
            AS document_chunks_present,
          to_regclass('public.documents') IS NOT NULL AS documents_present,
          to_regclass('public.repository_migration_items') IS NOT NULL
            AS migration_items_present,
          to_regclass('public.repository_migration_runs') IS NOT NULL
            AS migration_runs_present,
          to_regclass('public.repository_legacy_retirement_events') IS NOT NULL
            AS retirement_events_present
      `),
    );
    if (!relations?.retirement_events_present) return false;

    const [evidence] = toPgRows<{ retirement_events: number | string }>(
      await tx.execute(sql`
        SELECT COUNT(*)::integer AS retirement_events
        FROM repository_legacy_retirement_events
      `),
    );
    const finalized =
      !relations.document_chunks_present &&
      !relations.documents_present &&
      count(evidence?.retirement_events) > 0;
    if (finalized) return true;
    if (
      !relations.document_chunks_present ||
      !relations.documents_present ||
      !relations.migration_items_present ||
      !relations.migration_runs_present
    ) {
      return false;
    }

    const row = await loadRetirementGateRow(tx);
    return isRetirementGateReady(config, row);
  }, "contentRetirement.readGate");
}
