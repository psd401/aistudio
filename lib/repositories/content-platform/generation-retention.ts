import { sql, type SQL } from "drizzle-orm";
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

function eligibleGenerationCtes(params: {
  eligibleBefore: string;
  keepPerRepository: number;
  generationBatchSize: number;
}): SQL {
  const keepFloorOffset = params.keepPerRepository - 1;

  return sql`
    eligible_repositories AS MATERIALIZED (
      SELECT repository.id,
             repository.active_index_generation_id,
             keep_floor.superseded_at AS keep_floor_superseded_at,
             keep_floor.id AS keep_floor_id
      FROM knowledge_repositories repository
      CROSS JOIN LATERAL (
        SELECT kept_generation.superseded_at,
               kept_generation.id
        FROM repository_index_generations kept_generation
        WHERE kept_generation.repository_id = repository.id
          AND kept_generation.status = 'superseded'
        ORDER BY kept_generation.superseded_at DESC, kept_generation.id DESC
        OFFSET ${keepFloorOffset}
        LIMIT 1
      ) keep_floor
      WHERE EXISTS (
        SELECT 1
        FROM repository_index_generations candidate_generation
        WHERE candidate_generation.repository_id = repository.id
          AND candidate_generation.status = 'superseded'
          AND candidate_generation.superseded_at < ${params.eligibleBefore}::timestamptz
          AND (candidate_generation.superseded_at, candidate_generation.id) <
              (keep_floor.superseded_at, keep_floor.id)
          AND candidate_generation.id IS DISTINCT FROM repository.active_index_generation_id
          AND NOT EXISTS (
            SELECT 1
            FROM knowledge_repositories active_repository
            WHERE active_repository.active_index_generation_id = candidate_generation.id
          )
      )
      ORDER BY repository.id
      FOR UPDATE OF repository SKIP LOCKED
      LIMIT ${params.generationBatchSize}
    ),
    eligible_generations AS MATERIALIZED (
      SELECT generation.id
      FROM eligible_repositories repository
      CROSS JOIN LATERAL (
        SELECT candidate_generation.id
        FROM repository_index_generations candidate_generation
        WHERE candidate_generation.repository_id = repository.id
          AND candidate_generation.status = 'superseded'
          AND candidate_generation.superseded_at < ${params.eligibleBefore}::timestamptz
          AND (candidate_generation.superseded_at, candidate_generation.id) <
              (repository.keep_floor_superseded_at, repository.keep_floor_id)
          AND candidate_generation.id IS DISTINCT FROM repository.active_index_generation_id
          AND NOT EXISTS (
            SELECT 1
            FROM knowledge_repositories active_repository
            WHERE active_repository.active_index_generation_id = candidate_generation.id
          )
        ORDER BY candidate_generation.superseded_at, candidate_generation.id
        FOR UPDATE OF candidate_generation SKIP LOCKED
        LIMIT ${params.generationBatchSize}
      ) generation
      LIMIT ${params.generationBatchSize}
    )
  `;
}

/**
 * Delete one bounded batch from repository generations that are safely beyond
 * the rollback window. The keep floor is found with a bounded per-repository
 * index probe instead of ranking the complete superseded history. Repository
 * and generation rows are locked with SKIP LOCKED so multiple scheduler
 * invocations cannot work on the same parents. Chunks are removed first in a
 * ctid-bounded batch; a parent is deleted only after it is childless.
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
        WITH ${eligibleGenerationCtes({
          eligibleBefore,
          keepPerRepository,
          generationBatchSize,
        })},
        selected_chunks AS (
          SELECT chunk.ctid AS row_id
          FROM repository_item_chunks chunk
          INNER JOIN eligible_generations eligible
            ON eligible.id = chunk.index_generation_id
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
        WITH ${eligibleGenerationCtes({
          eligibleBefore,
          keepPerRepository,
          generationBatchSize,
        })},
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
