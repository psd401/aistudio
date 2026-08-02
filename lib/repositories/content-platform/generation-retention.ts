import { sql, type SQL } from "drizzle-orm";
import { executeTransaction, toPgRows } from "@/lib/db/drizzle-client";

export const SUPERSEDED_GENERATION_RETENTION_HOURS = 24;
export const SUPERSEDED_GENERATION_KEEP_PER_REPOSITORY = 3;
export const GENERATION_GC_CHUNK_BATCH = 20_000;
export const GENERATION_GC_REPOSITORY_BATCH = 200;
export const GENERATION_GC_GENERATION_BATCH = 200;
/** Prime stride prevents the minute-based probe window from aligning to ID blocks. */
const GENERATION_GC_REPOSITORY_PROBE_STRIDE = 104_729n;

export interface CollectSupersededRepositoryGenerationsOptions {
  /** Testable clock; production always uses the current time. */
  now?: Date;
  /** Test override; production always uses the exported retention window. */
  retentionHours?: number;
  /** Test override; production always keeps the exported generation floor. */
  keepPerRepository?: number;
  /** Test override; production always uses the exported chunk batch size. */
  chunkBatchSize?: number;
  /** Test override; production always uses the exported repository batch size. */
  repositoryBatchSize?: number;
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
  repositoryProbeAnchor: string;
  repositoryBatchSize: number;
  generationBatchSize: number;
}): SQL {
  const keepFloorOffset = params.keepPerRepository - 1;

  return sql`
    repository_probe_start AS (
      SELECT mod(
               ${params.repositoryProbeAnchor}::bigint,
               COALESCE(max(repository.id), 0)::bigint + 1
             )::integer AS id
      FROM knowledge_repositories repository
    ),
    repository_probe_ids AS MATERIALIZED (
      (
        SELECT repository.id
        FROM knowledge_repositories repository
        CROSS JOIN repository_probe_start probe_start
        WHERE repository.id >= probe_start.id
        ORDER BY repository.id
        LIMIT ${params.repositoryBatchSize}
      )
      UNION ALL
      (
        SELECT repository.id
        FROM knowledge_repositories repository
        CROSS JOIN repository_probe_start probe_start
        WHERE repository.id < probe_start.id
        ORDER BY repository.id
        LIMIT ${params.repositoryBatchSize}
      )
      LIMIT ${params.repositoryBatchSize}
    ),
    eligible_repositories AS MATERIALIZED (
      SELECT repository.id,
             repository.active_index_generation_id,
             keep_floor.superseded_at AS keep_floor_superseded_at,
             keep_floor.id AS keep_floor_id
      FROM repository_probe_ids probe
      INNER JOIN knowledge_repositories repository
        ON repository.id = probe.id
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
      CROSS JOIN LATERAL (
        SELECT candidate_generation.superseded_at,
               candidate_generation.id
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
        ORDER BY candidate_generation.superseded_at, candidate_generation.id
        LIMIT 1
      ) oldest_candidate
      ORDER BY oldest_candidate.superseded_at,
               oldest_candidate.id,
               repository.id
      FOR UPDATE OF repository SKIP LOCKED
      LIMIT ${params.repositoryBatchSize}
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
 * Eligible repositories are ordered by their oldest candidate so sustained
 * work on low repository IDs cannot starve older garbage elsewhere. A rotating
 * keyset window bounds steady-state repository probes even when nothing is
 * eligible. The owner row lock stabilizes every supported pointer update; the
 * global pointer guard additionally fails closed on pre-existing
 * cross-repository pointer skew.
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
  const repositoryBatchSize = requirePositiveInteger(
    options.repositoryBatchSize ?? GENERATION_GC_REPOSITORY_BATCH,
    "repositoryBatchSize",
  );
  const generationBatchSize = requirePositiveInteger(
    options.generationBatchSize ?? GENERATION_GC_GENERATION_BATCH,
    "generationBatchSize",
  );
  const collectionNow = options.now ?? new Date();
  const eligibleBefore = new Date(
    collectionNow.getTime() - retentionHours * 60 * 60_000,
  ).toISOString();
  const repositoryProbeAnchor = (
    BigInt(Math.floor(collectionNow.getTime() / 60_000)) *
    BigInt(repositoryBatchSize) *
    GENERATION_GC_REPOSITORY_PROBE_STRIDE
  ).toString();

  return executeTransaction(
    async (tx) => {
      const chunksResult = await tx.execute(sql`
        WITH ${eligibleGenerationCtes({
          eligibleBefore,
          keepPerRepository,
          repositoryProbeAnchor,
          repositoryBatchSize,
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
          repositoryProbeAnchor,
          repositoryBatchSize,
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
