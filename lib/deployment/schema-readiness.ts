import { and, eq, inArray, sql } from "drizzle-orm"
import { executeQuery, toPgRows } from "@/lib/db/drizzle-client"
import { migrationLog } from "@/lib/db/schema"
import { setDeploymentSchemaReadiness } from "./schema-readiness-state"

export const CRITICAL_SCHEMA_MIGRATIONS = [
  "116-unified-repository-content.sql",
  "121-unified-content-retrieval-v2.sql",
  "125-nexus-ephemeral-repositories.sql",
  "136-google-content-connectors.sql",
  "139-unified-content-agents-projects.sql",
  "155-unified-content-migration-retirement.sql",
  "159-unified-content-concurrency-recovery.sql",
  "168-repository-item-cancelled-status.sql",
  "169-agentic-model-readiness.sql",
  "170-nexus-durable-repository-bindings.sql",
] as const

interface ConstraintRow {
  definition: string
}

interface RepositorySchemaStructureRow {
  agentic_model_columns_ready: boolean
  nexus_binding_columns_ready: boolean
  nexus_binding_source_constraint_ready: boolean
  nexus_skill_foreign_key_ready: boolean
}

export interface CriticalSchemaSnapshot {
  appliedMigrations: string[]
  cancellationConstraintDefinition: string | null
  agenticModelColumnsReady: boolean
  nexusBindingColumnsReady: boolean
  nexusBindingSourceConstraintReady: boolean
  nexusSkillForeignKeyReady: boolean
}

export interface CriticalSchemaEvaluation {
  ready: boolean
  missingMigrations: string[]
  cancellationConstraintReady: boolean
  agenticModelColumnsReady: boolean
  nexusBindingColumnsReady: boolean
  nexusBindingSourceConstraintReady: boolean
  nexusSkillForeignKeyReady: boolean
}

export function evaluateCriticalSchema(
  snapshot: CriticalSchemaSnapshot
): CriticalSchemaEvaluation {
  const applied = new Set(snapshot.appliedMigrations)
  const missingMigrations = CRITICAL_SCHEMA_MIGRATIONS.filter(
    (migration) => !applied.has(migration)
  )
  const cancellationConstraintReady =
    snapshot.cancellationConstraintDefinition
      ?.toLowerCase()
      .includes("cancelled") ?? false
  const structureReady =
    snapshot.agenticModelColumnsReady &&
    snapshot.nexusBindingColumnsReady &&
    snapshot.nexusBindingSourceConstraintReady &&
    snapshot.nexusSkillForeignKeyReady

  return {
    ready:
      missingMigrations.length === 0 &&
      cancellationConstraintReady &&
      structureReady,
    missingMigrations,
    cancellationConstraintReady,
    agenticModelColumnsReady: snapshot.agenticModelColumnsReady,
    nexusBindingColumnsReady: snapshot.nexusBindingColumnsReady,
    nexusBindingSourceConstraintReady:
      snapshot.nexusBindingSourceConstraintReady,
    nexusSkillForeignKeyReady: snapshot.nexusSkillForeignKeyReady,
  }
}

export async function loadCriticalSchemaSnapshot(): Promise<CriticalSchemaSnapshot> {
  const migrations = await executeQuery(
    (db) =>
      db
        .select({ description: migrationLog.description })
        .from(migrationLog)
        .where(
          and(
            eq(migrationLog.status, "completed"),
            inArray(migrationLog.description, [...CRITICAL_SCHEMA_MIGRATIONS])
          )
        ),
    "deploymentSchemaReadiness.migrations"
  )
  const constraintResult = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname = 'repository_items_processing_status_check'
        LIMIT 1
      `),
    "deploymentSchemaReadiness.constraint"
  )
  const [constraint] = toPgRows<ConstraintRow>(constraintResult)
  const structureResult = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT
          (
            SELECT count(*) = 3
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'ai_models'
              AND column_name IN (
                'context_window_tokens',
                'max_output_tokens',
                'agentic_ready'
              )
          ) AS agentic_model_columns_ready,
          (
            to_regclass('public.nexus_conversation_repositories') IS NOT NULL
            AND (
              SELECT count(*) = 7
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'nexus_conversation_repositories'
                AND column_name IN (
                  'id',
                  'conversation_id',
                  'repository_id',
                  'source',
                  'source_id',
                  'created_by',
                  'created_at'
                )
            )
          ) AS nexus_binding_columns_ready,
          EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid =
              to_regclass('public.nexus_conversation_repositories')
              AND conname = 'chk_nexus_conversation_repository_source'
              AND pg_get_constraintdef(oid) ILIKE '%assistant%'
          ) AS nexus_binding_source_constraint_ready,
          EXISTS (
            SELECT 1
            FROM pg_constraint constraint_row
            JOIN pg_attribute attribute_row
              ON attribute_row.attrelid = constraint_row.conrelid
              AND attribute_row.attnum = ANY(constraint_row.conkey)
            WHERE constraint_row.conrelid =
              to_regclass('public.nexus_conversations')
              AND constraint_row.contype = 'f'
              AND attribute_row.attname = 'skill_id'
          ) AS nexus_skill_foreign_key_ready
      `),
    "deploymentSchemaReadiness.structure"
  )
  const [structure] =
    toPgRows<RepositorySchemaStructureRow>(structureResult)

  return {
    appliedMigrations: migrations.flatMap((row) =>
      row.description ? [row.description] : []
    ),
    cancellationConstraintDefinition: constraint?.definition ?? null,
    agenticModelColumnsReady:
      structure?.agentic_model_columns_ready ?? false,
    nexusBindingColumnsReady:
      structure?.nexus_binding_columns_ready ?? false,
    nexusBindingSourceConstraintReady:
      structure?.nexus_binding_source_constraint_ready ?? false,
    nexusSkillForeignKeyReady:
      structure?.nexus_skill_foreign_key_ready ?? false,
  }
}

export async function verifyDeploymentSchemaReadiness(): Promise<CriticalSchemaEvaluation> {
  try {
    const evaluation = evaluateCriticalSchema(
      await loadCriticalSchemaSnapshot()
    )
    if (!evaluation.ready) {
      const details = [
        evaluation.missingMigrations.length > 0
          ? `missing migrations: ${evaluation.missingMigrations.join(", ")}`
          : null,
        evaluation.cancellationConstraintReady
          ? null
          : "repository item cancellation constraint is stale",
        evaluation.agenticModelColumnsReady
          ? null
          : "agentic model admission columns are missing",
        evaluation.nexusBindingColumnsReady
          ? null
          : "Nexus repository binding table is incomplete",
        evaluation.nexusBindingSourceConstraintReady
          ? null
          : "Nexus repository binding source constraint is missing",
        evaluation.nexusSkillForeignKeyReady
          ? null
          : "Nexus skill binding foreign key is missing",
      ].filter((detail): detail is string => Boolean(detail))
      throw new Error(details.join("; "))
    }
    setDeploymentSchemaReadiness({
      status: "ready",
      checkedAt: new Date().toISOString(),
    })
    return evaluation
  } catch (error) {
    setDeploymentSchemaReadiness({
      status: "failed",
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
