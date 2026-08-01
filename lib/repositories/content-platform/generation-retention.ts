import { sql } from "drizzle-orm";
import { executeTransaction, toPgRows } from "@/lib/db/drizzle-client";

export const SUPERSEDED_GENERATION_RETENTION_HOURS = 24;
export const SUPERSEDED_GENERATION_KEEP_PER_REPOSITORY = 3;
export const GENERATION_GC_CHUNK_BATCH = 20_000;
export const GENERATION_GC_GENERATION_BATCH = 200;

export interface CollectSupersededRepositoryGenerationsOptions {
  /** Testable clock; production always uses the current time. */
  now?: Date;
  /** Test override; production always uses the exported retention window. */
  retentionHours?: number;
  /** Test override; production always keeps the exported generation floor. */
  keepPerRepository?: number;
  /** Test override; production always uses the exported chunk batch size. */
  chunkBatchSize?: number;
  /** Test override; production always uses the exported generation batch size. */
  generationBatchSize?: number;
}

export interface SupersededGenerationCollectionResult {
  chunksDeleted: number;
  generationsDeleted: number;
}

interface DeletedCountRow {
  deleted_count: number;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function deletedCount(result: unknown): number {
  const [row] = toPgRows<DeletedCountRow>(result);
  return row?.deleted_count ?? 0;
}

/**
 * Delete one bounded batch from repository generations that are safely beyond
 * the rollback window. Generation rows are locked with SKIP LOCKED so multiple
 * scheduler invocations cannot work on the same parents. Chunks are removed
 * first in a ctid-bounded batch; a parent is deleted only after it is childless.
 */
export async function collectSupersededRepositoryGenerations(
  options: CollectSupersededRepositoryGenerationsOptions = {},
): Promise<SupersededGenerationCollectionResult> {
  const retentionHours = requirePositiveInteger(
    options.retentionHours ?? SUPERSEDED_GENERATION_RETENTION_HOURS,
    "retentionHours",
  );
  const keepPerRepository = requirePositiveInteger(
    options.keepPerRepository ?? SUPERSEDED_GENERATION_KEEP_PER_REPOSITORY,
    "keepPerRepository",
  );
  const chunkBatchSize = requirePositiveInteger(
    options.chunkBatchSize ?? GENERATION_GC_CHUNK_BATCH,
    "chunkBatchSize",
  );
  const generationBatchSize = requirePositiveInteger(
    options.generationBatchSize ?? GENERATION_GC_GENERATION_BATCH,
    "generationBatchSize",
  );
  const eligibleBefore = new Date(
    (options.now ?? new Date()).getTime() - retentionHours * 60 * 60_000,
  ).toISOString();

  return executeTransaction(
    async (tx) => {
      const chunksResult = await tx.execute(sql`
        WITH ranked_superseded AS (
          SELECT generation.id,
                 row_number() OVER (
                   PARTITION BY generation.repository_id
                   ORDER BY generation.superseded_at DESC, generation.id DESC
                 ) AS superseded_rank
          FROM repository_index_generations generation
          WHERE generation.status = 'superseded'
        ),
        eligible_generations AS (
          SELECT generation.id
          FROM repository_index_generations generation
          INNER JOIN ranked_superseded ranked
            ON ranked.id = generation.id
          INNER JOIN knowledge_repositories repository
            ON repository.id = generation.repository_id
          WHERE generation.status = 'superseded'
            AND generation.superseded_at < ${eligibleBefore}::timestamptz
            AND ranked.superseded_rank > ${keepPerRepository}
            AND generation.id IS DISTINCT FROM repository.active_index_generation_id
            AND NOT EXISTS (
              SELECT 1
              FROM knowledge_repositories active_repository
              WHERE active_repository.active_index_generation_id = generation.id
            )
          ORDER BY generation.superseded_at, generation.id
          FOR UPDATE OF generation SKIP LOCKED
          LIMIT ${generationBatchSize}
        ),
        selected_chunks AS (
          SELECT chunk.ctid AS row_id
          FROM repository_item_chunks chunk
          INNER JOIN eligible_generations eligible
            ON eligible.id = chunk.index_generation_id
          ORDER BY chunk.id
          LIMIT ${chunkBatchSize}
        ),
        deleted_chunks AS (
          DELETE FROM repository_item_chunks chunk
          USING selected_chunks selected
          WHERE chunk.ctid = selected.row_id
          RETURNING 1
        )
        SELECT count(*)::integer AS deleted_count
        FROM deleted_chunks
      `);

      const generationsResult = await tx.execute(sql`
        WITH ranked_superseded AS (
          SELECT generation.id,
                 row_number() OVER (
                   PARTITION BY generation.repository_id
                   ORDER BY generation.superseded_at DESC, generation.id DESC
                 ) AS superseded_rank
          FROM repository_index_generations generation
          WHERE generation.status = 'superseded'
        ),
        eligible_generations AS (
          SELECT generation.id
          FROM repository_index_generations generation
          INNER JOIN ranked_superseded ranked
            ON ranked.id = generation.id
          INNER JOIN knowledge_repositories repository
            ON repository.id = generation.repository_id
          WHERE generation.status = 'superseded'
            AND generation.superseded_at < ${eligibleBefore}::timestamptz
            AND ranked.superseded_rank > ${keepPerRepository}
            AND generation.id IS DISTINCT FROM repository.active_index_generation_id
            AND NOT EXISTS (
              SELECT 1
              FROM knowledge_repositories active_repository
              WHERE active_repository.active_index_generation_id = generation.id
            )
          ORDER BY generation.superseded_at, generation.id
          FOR UPDATE OF generation SKIP LOCKED
          LIMIT ${generationBatchSize}
        ),
        deleted_generations AS (
          DELETE FROM repository_index_generations generation
          USING eligible_generations eligible,
                knowledge_repositories repository
          WHERE generation.id = eligible.id
            AND repository.id = generation.repository_id
            AND generation.status = 'superseded'
            AND generation.superseded_at < ${eligibleBefore}::timestamptz
            AND generation.id IS DISTINCT FROM repository.active_index_generation_id
            AND NOT EXISTS (
              SELECT 1
              FROM knowledge_repositories active_repository
              WHERE active_repository.active_index_generation_id = generation.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM repository_item_chunks remaining_chunk
              WHERE remaining_chunk.index_generation_id = generation.id
            )
          RETURNING 1
        )
        SELECT count(*)::integer AS deleted_count
        FROM deleted_generations
      `);

      return {
        chunksDeleted: deletedCount(chunksResult),
        generationsDeleted: deletedCount(generationsResult),
      };
    },
    "contentPlatform.collectSupersededRepositoryGenerations",
  );
}
