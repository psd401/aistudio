import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  toPgRows,
} from "@/lib/db/drizzle-client";
import {
  repositoryItems,
  repositoryMigrationItems,
  repositoryMigrationRuns,
  type RepositoryMigrationItemStatus,
  type RepositoryMigrationMetrics,
  type RepositoryMigrationMode,
  type RepositoryMigrationRunRow,
  type RepositoryMigrationSnapshot,
  type RepositoryMigrationSourceKind,
} from "@/lib/db/schema";
import { getContentPlatformConfig } from "./config";
import {
  assessContentRetirementReadiness,
  type RetirementReadiness,
} from "./migration-reconciliation";

export const REPOSITORY_MIGRATION_SOURCE_KINDS = [
  "repository_item",
  "nexus_document",
  "assistant_pdf_job",
] as const satisfies readonly RepositoryMigrationSourceKind[];

const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;

export interface RepositoryMigrationInventoryEntry {
  sourceKind: RepositoryMigrationSourceKind;
  discovered: number;
  maximumId: number;
  tracked: number;
  uncovered: number;
  verified: number;
}

export interface RepositoryMigrationDashboard {
  inventory: RepositoryMigrationInventoryEntry[];
  runs: RepositoryMigrationRunRow[];
  migrationMetrics: RepositoryMigrationMetrics;
  activeRunCount: number;
  staleRepositoryCount: number;
  processing: Record<string, number>;
  retrievalShadow: {
    observations: number;
    legacyResults: number;
    canonicalResults: number;
    overlappingItems: number;
  };
  recoveryWindowEndsAt: Date | null;
  rollbackDrillCompleted: boolean;
  dryRunCompleted: boolean;
  retirementFinalized: boolean;
  retirement: RetirementReadiness;
}

export interface RepositoryMigrationException {
  id: string;
  sourceKind: RepositoryMigrationSourceKind;
  sourceId: number;
  status: Extract<
    RepositoryMigrationItemStatus,
    "failed" | "unrecoverable" | "mismatch"
  >;
  sourceRecordCount: number | null;
  canonicalRecordCount: number | null;
  sourceContentSha256: string | null;
  canonicalContentSha256: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updatedAt: Date;
}

interface InventoryRow {
  source_kind: RepositoryMigrationSourceKind;
  discovered: number | string;
  maximum_id: number | string;
  tracked: number | string;
  uncovered: number | string;
}

function numberFromDatabase(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function assertLegacyRetirementNotFinalized(
  tx: Parameters<Parameters<typeof executeTransaction>[0]>[0],
): Promise<void> {
  const [state] = toPgRows<{ finalized: boolean }>(
    await tx.execute(sql`
      SELECT (
        to_regclass('public.documents') IS NULL
        AND to_regclass('public.document_chunks') IS NULL
        AND EXISTS (
          SELECT 1
          FROM repository_legacy_retirement_events
        )
      ) AS finalized
    `),
  );
  if (state?.finalized) {
    throw new Error(
      "Legacy content retirement is finalized; migration controls are read-only",
    );
  }
}

export async function getRepositoryMigrationInventory(): Promise<
  RepositoryMigrationInventoryEntry[]
> {
  return executeTransaction(async (tx) => {
    // The finalizer takes this same lock before dropping legacy tables. This
    // makes the table-existence check and optional documents query atomic.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('repository-content-migration'))`,
    );
    const [tableState] = toPgRows<{ documents_present: boolean }>(
      await tx.execute(sql`
        SELECT to_regclass('public.documents') IS NOT NULL
          AS documents_present
      `),
    );
    const repositoryInventory = toPgRows<InventoryRow>(
      await tx.execute(sql`
        SELECT
          'repository_item'::varchar AS source_kind,
          COUNT(*)::integer AS discovered,
          COALESCE(MAX(item.id), 0)::bigint AS maximum_id,
          0::integer AS tracked,
          COUNT(*) FILTER (
            WHERE NOT EXISTS (
              SELECT 1
              FROM repository_migration_items migration
              WHERE migration.source_kind = 'repository_item'
                AND migration.source_id = item.id
                AND migration.status = 'verified'
            )
          )::integer AS uncovered
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
      `),
    )[0];
    const nexusInventory = tableState?.documents_present
      ? toPgRows<InventoryRow>(
          await tx.execute(sql`
            SELECT
              'nexus_document'::varchar AS source_kind,
              COUNT(*)::integer AS discovered,
              COALESCE(MAX(id), 0)::bigint AS maximum_id,
              0::integer AS tracked,
              COUNT(*) FILTER (
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM repository_migration_items migration
                  WHERE migration.source_kind = 'nexus_document'
                    AND migration.source_id = document.id
                    AND migration.status = 'verified'
                )
              )::integer AS uncovered
            FROM documents document
          `),
        )[0]
      : undefined;
    const assistantInventory = toPgRows<InventoryRow>(
      await tx.execute(sql`
        SELECT
          'assistant_pdf_job'::varchar AS source_kind,
          COUNT(*)::integer AS discovered,
          COALESCE(MAX(id), 0)::bigint AS maximum_id,
          0::integer AS tracked,
          COUNT(*) FILTER (
            WHERE NOT EXISTS (
              SELECT 1
              FROM repository_migration_items migration
              WHERE migration.source_kind = 'assistant_pdf_job'
                AND migration.source_id = job.id
                AND migration.status = 'verified'
            )
          )::integer AS uncovered
        FROM jobs job
        WHERE job.type = 'pdf-to-markdown'
      `),
    )[0];
    const trackedRows = toPgRows<{
      source_kind: RepositoryMigrationSourceKind;
      tracked: number | string;
      verified: number | string;
    }>(
      await tx.execute(sql`
        SELECT
          source_kind,
          COUNT(*)::integer AS tracked,
          COUNT(*) FILTER (WHERE status = 'verified')::integer AS verified
        FROM repository_migration_items
        GROUP BY source_kind
      `),
    );
    const discoveredByKind = new Map(
      [repositoryInventory, nexusInventory, assistantInventory]
        .filter((row): row is InventoryRow => Boolean(row))
        .map((row) => [row.source_kind, row]),
    );
    const trackedByKind = new Map(
      trackedRows.map((row) => [
        row.source_kind,
        numberFromDatabase(row.tracked),
      ]),
    );
    const verifiedByKind = new Map(
      trackedRows.map((row) => [
        row.source_kind,
        numberFromDatabase(row.verified),
      ]),
    );
    return REPOSITORY_MIGRATION_SOURCE_KINDS.map((sourceKind) => {
      const inventory = discoveredByKind.get(sourceKind);
      return {
        sourceKind,
        discovered: numberFromDatabase(inventory?.discovered),
        maximumId: numberFromDatabase(inventory?.maximum_id),
        tracked: trackedByKind.get(sourceKind) ?? 0,
        uncovered: numberFromDatabase(inventory?.uncovered),
        verified: verifiedByKind.get(sourceKind) ?? 0,
      };
    });
  }, "contentMigration.inventory");
}

function validateSourceKinds(
  sourceKinds: RepositoryMigrationSourceKind[],
): RepositoryMigrationSourceKind[] {
  const unique = [...new Set(sourceKinds)];
  if (
    unique.length === 0 ||
    unique.some(
      (sourceKind) => !REPOSITORY_MIGRATION_SOURCE_KINDS.includes(sourceKind),
    )
  ) {
    throw new Error("At least one supported migration source kind is required");
  }
  return unique;
}

export interface StartRepositoryMigrationRunInput {
  mode: Exclude<RepositoryMigrationMode, "rollback">;
  sourceKinds?: RepositoryMigrationSourceKind[];
  requestedBy: number;
}

export async function startRepositoryMigrationRun(
  input: StartRepositoryMigrationRunInput,
): Promise<RepositoryMigrationRunRow> {
  const sourceKinds = validateSourceKinds(
    input.sourceKinds ?? [...REPOSITORY_MIGRATION_SOURCE_KINDS],
  );
  const inventory = (await getRepositoryMigrationInventory()).filter((entry) =>
    sourceKinds.includes(entry.sourceKind),
  );
  const discovered = inventory.reduce(
    (total, entry) => total + entry.discovered,
    0,
  );
  const snapshot: RepositoryMigrationSnapshot = {
    maximumIds: Object.fromEntries(
      inventory.map((entry) => [entry.sourceKind, entry.maximumId]),
    ),
    counts: Object.fromEntries(
      inventory.map((entry) => [entry.sourceKind, entry.discovered]),
    ),
  };
  const isDryRun = input.mode === "dry_run";

  return executeTransaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('repository-content-migration'))`,
    );
    await assertLegacyRetirementNotFinalized(tx);
    const [active] = await tx
      .select({ id: repositoryMigrationRuns.id })
      .from(repositoryMigrationRuns)
      .where(inArray(repositoryMigrationRuns.status, [...ACTIVE_RUN_STATUSES]))
      .limit(1);
    if (active) throw new Error("Another content migration run is active");

    const now = new Date();
    const [created] = await tx
      .insert(repositoryMigrationRuns)
      .values({
        mode: input.mode,
        status: isDryRun ? "completed" : "queued",
        requestedBy: input.requestedBy,
        sourceKinds,
        cursor: {},
        snapshot,
        metrics: { discovered },
        startedAt: isDryRun ? now : null,
        finishedAt: isDryRun ? now : null,
      })
      .returning();
    if (!created) throw new Error("Failed to create content migration run");
    return created;
  }, "contentMigration.startRun");
}

export async function startRepositoryRollbackRun(input: {
  parentRunId: string;
  requestedBy: number;
}): Promise<RepositoryMigrationRunRow> {
  return executeTransaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('repository-content-migration'))`,
    );
    await assertLegacyRetirementNotFinalized(tx);
    const [active] = await tx
      .select({ id: repositoryMigrationRuns.id })
      .from(repositoryMigrationRuns)
      .where(inArray(repositoryMigrationRuns.status, [...ACTIVE_RUN_STATUSES]))
      .limit(1);
    if (active) throw new Error("Another content migration run is active");

    const [parent] = await tx
      .select()
      .from(repositoryMigrationRuns)
      .where(eq(repositoryMigrationRuns.id, input.parentRunId))
      .limit(1)
      .for("update");
    if (
      !parent ||
      parent.mode !== "backfill" ||
      !["completed", "completed_with_errors"].includes(parent.status)
    ) {
      throw new Error("Rollback requires a completed backfill run");
    }
    if (
      !parent.recoveryWindowEndsAt ||
      parent.recoveryWindowEndsAt <= new Date()
    ) {
      throw new Error("The backfill recovery window has elapsed");
    }
    const [run] = await tx
      .insert(repositoryMigrationRuns)
      .values({
        mode: "rollback",
        status: "queued",
        requestedBy: input.requestedBy,
        sourceKinds: parent.sourceKinds,
        snapshot: {
          parentRunId: parent.id,
          counts: parent.snapshot.counts,
        },
        metrics: {},
      })
      .returning();
    if (!run) throw new Error("Failed to create rollback run");
    return run;
  }, "contentMigration.startRollback");
}

export async function retryRepositoryMigrationItem(
  migrationItemId: string,
  requestedBy: number,
): Promise<RepositoryMigrationRunRow> {
  return executeTransaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('repository-content-migration'))`,
    );
    await assertLegacyRetirementNotFinalized(tx);
    const [active] = await tx
      .select({ id: repositoryMigrationRuns.id })
      .from(repositoryMigrationRuns)
      .where(inArray(repositoryMigrationRuns.status, [...ACTIVE_RUN_STATUSES]))
      .limit(1);
    if (active) throw new Error("Another content migration run is active");

    const [item] = await tx
      .select()
      .from(repositoryMigrationItems)
      .where(eq(repositoryMigrationItems.id, migrationItemId))
      .limit(1)
      .for("update");
    if (
      !item ||
      !["failed", "unrecoverable", "mismatch"].includes(item.status)
    ) {
      throw new Error("Only a failed or mismatched migration can be retried");
    }
    const cursorValue = Math.max(0, item.sourceId - 1);
    const snapshot: RepositoryMigrationSnapshot = {
      maximumIds: { [item.sourceKind]: item.sourceId },
      counts: { [item.sourceKind]: 1 },
    };
    const [run] = await tx
      .insert(repositoryMigrationRuns)
      .values({
        mode: "backfill",
        status: "queued",
        requestedBy,
        sourceKinds: [item.sourceKind],
        cursor: { [item.sourceKind]: cursorValue },
        snapshot,
        metrics: { discovered: 1 },
      })
      .returning();
    if (!run) throw new Error("Failed to create migration retry run");
    await tx
      .update(repositoryMigrationItems)
      .set({
        runId: run.id,
        status: "pending",
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(repositoryMigrationItems.id, item.id));
    return run;
  }, "contentMigration.retryItem");
}

export async function approveRepositoryMigrationMismatch(input: {
  migrationItemId: string;
  approvedBy: number;
  reason: string;
}): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 1_000) {
    throw new Error("A 10-1000 character reconciliation reason is required");
  }
  await executeTransaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('repository-content-migration'))`,
    );
    await assertLegacyRetirementNotFinalized(tx);
    const [item] = await tx
      .select()
      .from(repositoryMigrationItems)
      .where(eq(repositoryMigrationItems.id, input.migrationItemId))
      .limit(1)
      .for("update");
    if (!item || item.status !== "mismatch") {
      throw new Error(
        "Migration mismatch no longer exists or is not approvable",
      );
    }
    const approvedAt = new Date();
    await tx
      .update(repositoryMigrationItems)
      .set({
        status: "verified",
        verifiedAt: approvedAt,
        metadata: {
          ...item.metadata,
          approvedMismatchAt: approvedAt.toISOString(),
          approvedMismatchBy: input.approvedBy,
          approvedMismatchReason: reason,
        },
        updatedAt: approvedAt,
      })
      .where(eq(repositoryMigrationItems.id, item.id));
  }, "contentMigration.approveMismatch");
}

export async function listRepositoryMigrationExceptions(
  limit = 50,
): Promise<RepositoryMigrationException[]> {
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
  return executeQuery(
    (db) =>
      db
        .select({
          id: repositoryMigrationItems.id,
          sourceKind: repositoryMigrationItems.sourceKind,
          sourceId: repositoryMigrationItems.sourceId,
          status: repositoryMigrationItems.status,
          sourceRecordCount: repositoryMigrationItems.sourceRecordCount,
          canonicalRecordCount: repositoryMigrationItems.canonicalRecordCount,
          sourceContentSha256: repositoryMigrationItems.sourceContentSha256,
          canonicalContentSha256:
            repositoryMigrationItems.canonicalContentSha256,
          lastErrorCode: repositoryMigrationItems.lastErrorCode,
          lastErrorMessage: repositoryMigrationItems.lastErrorMessage,
          updatedAt: repositoryMigrationItems.updatedAt,
        })
        .from(repositoryMigrationItems)
        .where(
          inArray(repositoryMigrationItems.status, [
            "failed",
            "unrecoverable",
            "mismatch",
          ]),
        )
        .orderBy(desc(repositoryMigrationItems.updatedAt))
        .limit(safeLimit),
    "contentMigration.listExceptions",
  ) as Promise<RepositoryMigrationException[]>;
}

export async function runRepositoryMigrationRollbackDrill(
  requestedBy: number,
): Promise<RepositoryMigrationRunRow> {
  return executeTransaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('repository-content-migration'))`,
    );
    await assertLegacyRetirementNotFinalized(tx);
    const [active] = await tx
      .select({ id: repositoryMigrationRuns.id })
      .from(repositoryMigrationRuns)
      .where(inArray(repositoryMigrationRuns.status, [...ACTIVE_RUN_STATUSES]))
      .limit(1);
    if (active) throw new Error("Another content migration run is active");

    const sample = toPgRows<{
      migration_id: string;
      item_id: number;
      version_id: string;
    }>(
      await tx.execute(sql`
        SELECT
          migration.id AS migration_id,
          item.id AS item_id,
          migration.canonical_version_id AS version_id
        FROM repository_migration_items migration
        JOIN repository_items item
          ON item.id = migration.canonical_item_id
        WHERE migration.source_kind = 'repository_item'
          AND migration.status = 'verified'
          AND item.current_version_id = migration.canonical_version_id
          AND EXISTS (
            SELECT 1
            FROM repository_item_chunks legacy_chunk
            WHERE legacy_chunk.item_id = item.id
              AND legacy_chunk.item_version_id IS NULL
          )
        ORDER BY migration.verified_at, migration.id
        LIMIT 1
        FOR UPDATE OF item
      `),
    )[0];
    if (!sample) {
      throw new Error(
        "Rollback drill requires a verified Repository item with legacy chunks",
      );
    }

    await tx
      .update(repositoryItems)
      .set({ currentVersionId: null, updatedAt: new Date() })
      .where(eq(repositoryItems.id, sample.item_id));
    const probe = toPgRows<{ legacy_count: number }>(
      await tx.execute(sql`
        SELECT COUNT(*)::integer AS legacy_count
        FROM repository_item_chunks
        WHERE item_id = ${sample.item_id}
          AND item_version_id IS NULL
      `),
    )[0];
    if (!probe || probe.legacy_count < 1) {
      throw new Error(
        "Rollback drill could not restore the legacy read source",
      );
    }
    await tx
      .update(repositoryItems)
      .set({
        currentVersionId: sample.version_id,
        updatedAt: new Date(),
      })
      .where(eq(repositoryItems.id, sample.item_id));

    const now = new Date();
    const [run] = await tx
      .insert(repositoryMigrationRuns)
      .values({
        mode: "rollback",
        status: "completed",
        requestedBy,
        sourceKinds: ["repository_item"],
        snapshot: {
          counts: { repository_item: 1 },
        },
        metrics: { rolledBack: 1 },
        startedAt: now,
        finishedAt: now,
      })
      .returning();
    if (!run) throw new Error("Failed to record rollback drill");
    await tx.execute(sql`
      UPDATE repository_migration_runs
      SET snapshot = snapshot || jsonb_build_object(
        'rollbackDrill', true,
        'migrationItemId', ${sample.migration_id},
        'canonicalItemId', ${sample.item_id}
      )
      WHERE id = ${run.id}::uuid
    `);
    return {
      ...run,
      snapshot: {
        ...run.snapshot,
        rollbackDrill: true,
        migrationItemId: sample.migration_id,
        canonicalItemId: sample.item_id,
      } as RepositoryMigrationSnapshot,
    };
  }, "contentMigration.rollbackDrill");
}

function migrationMetricsFromRows(
  rows: Array<{
    status: RepositoryMigrationItemStatus;
    count: number | string;
  }>,
): RepositoryMigrationMetrics {
  const counts = Object.fromEntries(
    rows.map((row) => [row.status, numberFromDatabase(row.count)]),
  ) as Partial<Record<RepositoryMigrationItemStatus, number>>;
  return {
    discovered: Object.values(counts).reduce(
      (total, value) => total + (value ?? 0),
      0,
    ),
    migrated:
      (counts.migrated ?? 0) + (counts.verified ?? 0) + (counts.mismatch ?? 0),
    verified: counts.verified ?? 0,
    mismatched: counts.mismatch ?? 0,
    failed: counts.failed ?? 0,
    unrecoverable: counts.unrecoverable ?? 0,
    rolledBack: counts.rolled_back ?? 0,
  };
}

export async function getRepositoryMigrationDashboard(): Promise<RepositoryMigrationDashboard> {
  const [inventory, runs, statusRows, operationalRows, config] =
    await Promise.all([
      getRepositoryMigrationInventory(),
      executeQuery(
        (db) =>
          db
            .select()
            .from(repositoryMigrationRuns)
            .orderBy(desc(repositoryMigrationRuns.createdAt))
            .limit(20),
        "contentMigration.dashboardRuns",
      ),
      executeQuery(
        (db) =>
          db
            .select({
              status: repositoryMigrationItems.status,
              count: sql<number>`COUNT(*)::integer`,
            })
            .from(repositoryMigrationItems)
            .groupBy(repositoryMigrationItems.status),
        "contentMigration.dashboardStatuses",
      ),
      executeQuery(
        (db) =>
          db.execute(sql`
            SELECT
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
                FROM repository_migration_runs
                WHERE status IN ('queued', 'running')
              ) AS active_runs,
              (
                SELECT COUNT(*)::integer
                FROM repository_migration_runs
                WHERE mode = 'rollback'
                  AND status = 'completed'
                  AND snapshot->>'rollbackDrill' = 'true'
              ) AS rollback_drills,
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
                to_regclass('public.documents') IS NULL
                AND to_regclass('public.document_chunks') IS NULL
                AND EXISTS (
                  SELECT 1
                  FROM repository_legacy_retirement_events
                )
              ) AS retirement_finalized,
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
              (
                SELECT COALESCE(jsonb_object_agg(status, count), '{}'::jsonb)
                FROM (
                  SELECT status, COUNT(*)::integer AS count
                  FROM repository_processing_jobs
                  GROUP BY status
                ) processing_counts
              ) AS processing,
              (
                SELECT jsonb_build_object(
                  'observations', COUNT(*)::integer,
                  'legacyResults', COALESCE(SUM(legacy_result_count), 0)::integer,
                  'canonicalResults', COALESCE(SUM(canonical_result_count), 0)::integer,
                  'overlappingItems', COALESCE(SUM(overlapping_item_count), 0)::integer
                )
                FROM repository_retrieval_shadow_observations
                WHERE created_at >= NOW() - INTERVAL '24 hours'
              ) AS retrieval_shadow
          `),
        "contentMigration.dashboardOperational",
      ),
      getContentPlatformConfig(),
    ]);

  const migrationMetrics = migrationMetricsFromRows(statusRows);
  const operational = toPgRows<{
    stale_repositories: number;
    active_runs: number;
    rollback_drills: number;
    dry_runs: number;
    retirement_finalized: boolean;
    recovery_window_ends_at: Date | string | null;
    processing: Record<string, number> | string;
    retrieval_shadow:
      | {
          observations: number;
          legacyResults: number;
          canonicalResults: number;
          overlappingItems: number;
        }
      | string;
  }>(operationalRows)[0];
  const parseRecord = <T extends Record<string, unknown>>(
    value: T | string | undefined,
    fallback: T,
  ): T => {
    if (typeof value !== "string") return value ?? fallback;
    return JSON.parse(value) as T;
  };
  const activeRunCount = numberFromDatabase(operational?.active_runs);
  const rollbackDrillCompleted =
    numberFromDatabase(operational?.rollback_drills) > 0;
  const dryRunCompleted = numberFromDatabase(operational?.dry_runs) > 0;
  const recoveryWindowEndsAt = operational?.recovery_window_ends_at
    ? new Date(operational.recovery_window_ends_at)
    : null;
  const cutoversEnabled =
    config.enabled &&
    config.readV2Enabled &&
    config.repositoryCutoverEnabled &&
    config.nexusCutoverEnabled &&
    config.assistantArchitectCutoverEnabled;
  const retirement = assessContentRetirementReadiness({
    cutoversEnabled,
    retirementConfigured: config.legacyRetirementEnabled,
    dryRunCompleted,
    inventoryComplete:
      operational?.retirement_finalized === true ||
      inventory.every((entry) => entry.uncovered === 0),
    activeRunCount,
    migrationMetrics,
    rollbackDrillCompleted,
    recoveryWindowEndsAt,
  });
  return {
    inventory,
    runs,
    migrationMetrics,
    activeRunCount,
    staleRepositoryCount: numberFromDatabase(operational?.stale_repositories),
    processing: parseRecord<Record<string, number>>(
      operational?.processing,
      {},
    ),
    retrievalShadow: parseRecord(operational?.retrieval_shadow, {
      observations: 0,
      legacyResults: 0,
      canonicalResults: 0,
      overlappingItems: 0,
    }),
    recoveryWindowEndsAt,
    rollbackDrillCompleted,
    dryRunCompleted,
    retirementFinalized: operational?.retirement_finalized === true,
    retirement,
  };
}
