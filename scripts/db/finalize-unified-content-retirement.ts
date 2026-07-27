/**
 * Finalize unified-content retirement after the guarded recovery window.
 *
 * Dry-run (default):
 *   DATABASE_URL=postgres://... bun run db:finalize-content-retirement
 *
 * Execute (irreversible; requires both arguments):
 *   DATABASE_URL=postgres://... bun run db:finalize-content-retirement -- \
 *     --execute --confirmation=RETIRE_LEGACY_CONTENT
 */

import postgres from "postgres";
import {
  assessLegacyRetirementFinalization,
  LEGACY_RETIREMENT_CONFIRMATION,
  parseLegacyRetirementArguments,
  type LegacyRetirementDatabaseSnapshot,
} from "../../lib/repositories/content-platform/retirement-finalization";
import { scriptLogger as log } from "./script-logger";

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/aistudio";
const sslEnabled = process.env.DB_SSL !== "false";

type RetirementSql = postgres.Sql;

interface GateRow {
  active_runs: number | string;
  assistant_cutover: boolean;
  dry_runs: number | string;
  discovered: number | string;
  failed: number | string;
  migrated: number | string;
  mismatched: number | string;
  nexus_cutover: boolean;
  platform_enabled: boolean;
  read_v2_enabled: boolean;
  recovery_window_ends_at: Date | string | null;
  repository_cutover: boolean;
  retirement_enabled: boolean;
  rollback_drills: number | string;
  unrecoverable: number | string;
  verified: number | string;
}

interface TableStateRow {
  document_chunks_table_present: boolean;
  documents_table_present: boolean;
}

interface CountRow {
  count: number | string;
}

function count(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readCount(
  sql: RetirementSql,
  table:
    | "document_chunks"
    | "documents"
    | "assistant_pdf_jobs"
    | "retirement_events",
): Promise<number> {
  let rows: CountRow[];
  switch (table) {
    case "document_chunks":
      rows = await sql<
        CountRow[]
      >`SELECT COUNT(*)::integer AS count FROM document_chunks`;
      break;
    case "documents":
      rows = await sql<
        CountRow[]
      >`SELECT COUNT(*)::integer AS count FROM documents`;
      break;
    case "assistant_pdf_jobs":
      rows = await sql<CountRow[]>`
        SELECT COUNT(*)::integer AS count
        FROM jobs
        WHERE type = 'pdf-to-markdown'
      `;
      break;
    case "retirement_events":
      rows = await sql<CountRow[]>`
        SELECT COUNT(*)::integer AS count
        FROM repository_legacy_retirement_events
      `;
      break;
  }
  return count(rows[0]?.count);
}

async function readSnapshot(
  sql: RetirementSql,
): Promise<LegacyRetirementDatabaseSnapshot> {
  const [gate] = await sql<GateRow[]>`
    SELECT
      (
        SELECT COUNT(*)::integer
        FROM repository_migration_runs
        WHERE status IN ('queued', 'running')
      ) AS active_runs,
      (
        SELECT COUNT(*)::integer
        FROM repository_migration_runs
        WHERE mode = 'dry_run'
          AND status = 'completed'
          AND source_kinds @> '[
            "repository_item",
            "nexus_document",
            "assistant_pdf_job"
          ]'::jsonb
      ) AS dry_runs,
      (
        SELECT COUNT(*)::integer
        FROM repository_migration_items
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
      (
        SELECT COUNT(*)::integer
        FROM repository_migration_runs
        WHERE mode = 'rollback'
          AND status = 'completed'
          AND snapshot->>'rollbackDrill' = 'true'
      ) AS rollback_drills,
      GREATEST(
        (
          SELECT MAX(recovery_window_ends_at)
          FROM repository_migration_runs
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
      COALESCE((
        SELECT value::boolean FROM settings
        WHERE key = 'CONTENT_PLATFORM_ENABLED'
      ), false) AS platform_enabled,
      COALESCE((
        SELECT value::boolean FROM settings
        WHERE key = 'CONTENT_READ_V2_ENABLED'
      ), false) AS read_v2_enabled,
      COALESCE((
        SELECT value::boolean FROM settings
        WHERE key = 'CONTENT_REPOSITORY_CUTOVER_ENABLED'
      ), false) AS repository_cutover,
      COALESCE((
        SELECT value::boolean FROM settings
        WHERE key = 'CONTENT_NEXUS_CUTOVER_ENABLED'
      ), false) AS nexus_cutover,
      COALESCE((
        SELECT value::boolean FROM settings
        WHERE key = 'CONTENT_ASSISTANT_ARCHITECT_CUTOVER_ENABLED'
      ), false) AS assistant_cutover,
      COALESCE((
        SELECT value::boolean FROM settings
        WHERE key = 'CONTENT_LEGACY_RETIREMENT_ENABLED'
      ), false) AS retirement_enabled
  `;
  if (!gate) throw new Error("Retirement gate query returned no row");

  const [tableState] = await sql<TableStateRow[]>`
    SELECT
      to_regclass('public.documents') IS NOT NULL AS documents_table_present,
      to_regclass('public.document_chunks') IS NOT NULL
        AS document_chunks_table_present
  `;
  if (!tableState) throw new Error("Legacy table-state query returned no row");

  let uncovered = 0;
  if (
    tableState.documents_table_present &&
    tableState.document_chunks_table_present
  ) {
    const [coverage] = await sql<CountRow[]>`
      SELECT (
        SELECT COUNT(*)::integer
        FROM repository_items item
        JOIN knowledge_repositories repository
          ON repository.id = item.repository_id
        WHERE item.lifecycle_status = 'active'
          AND repository.lifecycle_status = 'active'
          AND item.type IN ('document', 'text', 'url')
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
      ) AS count
    `;
    uncovered = count(coverage?.count);
  }

  return {
    activeRuns: count(gate.active_runs),
    dryRuns: count(gate.dry_runs),
    discovered: count(gate.discovered),
    migrated: count(gate.migrated),
    verified: count(gate.verified),
    mismatched: count(gate.mismatched),
    failed: count(gate.failed),
    unrecoverable: count(gate.unrecoverable),
    rollbackDrills: count(gate.rollback_drills),
    recoveryWindowEndsAt: gate.recovery_window_ends_at
      ? new Date(gate.recovery_window_ends_at)
      : null,
    cutoversEnabled:
      gate.platform_enabled &&
      gate.read_v2_enabled &&
      gate.repository_cutover &&
      gate.nexus_cutover &&
      gate.assistant_cutover,
    retirementConfigured: gate.retirement_enabled,
    documentsTablePresent: tableState.documents_table_present,
    documentChunksTablePresent: tableState.document_chunks_table_present,
    documentCount: tableState.documents_table_present
      ? await readCount(sql, "documents")
      : 0,
    documentChunkCount: tableState.document_chunks_table_present
      ? await readCount(sql, "document_chunks")
      : 0,
    assistantPdfJobCount: await readCount(sql, "assistant_pdf_jobs"),
    priorRetirementEvents: await readCount(sql, "retirement_events"),
    inventoryComplete: uncovered === 0,
  };
}

function logSnapshot(
  snapshot: LegacyRetirementDatabaseSnapshot,
  blockers: string[],
): void {
  log.info("Retirement evidence", {
    ...snapshot,
    recoveryWindowEndsAt: snapshot.recoveryWindowEndsAt?.toISOString() ?? null,
  });
  for (const blocker of blockers) log.warn("Retirement blocked", { blocker });
}

async function main(): Promise<void> {
  const args = parseLegacyRetirementArguments(process.argv.slice(2));
  log.section("Unified Content Legacy Retirement Finalizer (#1267)");
  log.info("Database", { url: databaseUrl.replace(/:\/\/.*@/, "://*****@") });
  log.info("Mode", { execute: args.execute });

  const sql = postgres(databaseUrl, {
    ssl: sslEnabled ? "require" : false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  try {
    const initial = await sql.begin(async (tx) => {
      const transactionSql = tx as unknown as postgres.Sql;
      await transactionSql`
        SELECT pg_advisory_xact_lock(
          hashtext('repository-content-migration')
        )
      `;
      return readSnapshot(transactionSql);
    });
    const initialAssessment = assessLegacyRetirementFinalization(initial);
    logSnapshot(initial, initialAssessment.blockers);

    if (initialAssessment.alreadyFinalized) {
      log.success(
        "Legacy content tables were already retired with audit evidence.",
      );
      return;
    }
    if (!initialAssessment.ready) {
      log.fail("Retirement gates are not satisfied; no changes were made.");
      process.exitCode = 3;
      return;
    }
    if (!args.execute) {
      log.success(
        `Dry run passed. Re-run with --execute --confirmation=${LEGACY_RETIREMENT_CONFIRMATION}.`,
      );
      return;
    }
    if (!args.confirmed) {
      log.fail(
        `Execution requires --confirmation=${LEGACY_RETIREMENT_CONFIRMATION}; no changes were made.`,
      );
      process.exitCode = 3;
      return;
    }

    let alreadyFinalizedByPeer = false;
    await sql.begin(async (tx) => {
      // postgres.js transaction objects retain the Sql tagged-template API at
      // runtime, although its published TransactionSql type omits that call
      // signature.
      const transactionSql = tx as unknown as postgres.Sql;
      await transactionSql`
        SELECT pg_advisory_xact_lock(
          hashtext('repository-content-migration')
        )
      `;
      const preLock = await readSnapshot(transactionSql);
      const preLockAssessment = assessLegacyRetirementFinalization(preLock);
      if (preLockAssessment.alreadyFinalized) {
        alreadyFinalizedByPeer = true;
        return;
      }
      if (!preLockAssessment.ready) {
        throw new Error(
          `Retirement gates changed before lock: ${preLockAssessment.blockers.join("; ")}`,
        );
      }
      await transactionSql`
        LOCK TABLE documents, document_chunks IN ACCESS EXCLUSIVE MODE
      `;

      const locked = await readSnapshot(transactionSql);
      const assessment = assessLegacyRetirementFinalization(locked);
      if (!assessment.ready || assessment.alreadyFinalized) {
        throw new Error(
          `Retirement gates changed after lock: ${assessment.blockers.join("; ")}`,
        );
      }

      await transactionSql`DELETE FROM jobs WHERE type = 'pdf-to-markdown'`;
      await transactionSql`DROP TABLE document_chunks`;
      await transactionSql`DROP TABLE documents`;
      await transactionSql`
        INSERT INTO repository_legacy_retirement_events (evidence)
        VALUES (${transactionSql.json({
          documentCount: locked.documentCount,
          documentChunkCount: locked.documentChunkCount,
          assistantPdfJobCount: locked.assistantPdfJobCount,
          migrated: locked.migrated,
          discovered: locked.discovered,
          verified: locked.verified,
          rollbackDrills: locked.rollbackDrills,
          recoveryWindowEndsAt:
            locked.recoveryWindowEndsAt?.toISOString() ?? null,
        })})
      `;
    });
    if (alreadyFinalizedByPeer) {
      log.success(
        "Legacy content tables were retired by another evidenced finalizer.",
      );
      return;
    }
    log.success(
      "Legacy documents, chunks, and Assistant Architect PDF jobs were retired atomically.",
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  log.error("Unified content retirement finalization failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(2);
});
