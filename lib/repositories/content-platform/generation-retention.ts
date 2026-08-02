import { sql, type SQL } from "drizzle-orm";
import { executeTransaction, toPgRows } from "@/lib/db/drizzle-client";

export const SUPERSEDED_GENERATION_RETENTION_HOURS = 24;
export const SUPERSEDED_GENERATION_KEEP_PER_REPOSITORY = 3;
export const GENERATION_GC_CHUNK_BATCH = 20_000;
export const GENERATION_GC_REPOSITORY_BATCH = 200;
export const GENERATION_GC_GENERATION_BATCH = 200;
export const GENERATION_GC_PER_REPOSITORY_BATCH = 10;

const GENERATION_GC_CURSOR_SETTING_KEY = "REPOSITORY_GENERATION_GC_CURSOR";

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
  /** Test override; production always uses the per-repository generation cap. */
  perRepositoryGenerationBatchSize?: number;
}

export interface SupersededGenerationCollectionResult {
  chunksDeleted: number;
  generationsDeleted: number;
}

interface DeletedCountRow {
  deleted_count: number;
}

interface RepositoryProbeCursorRow {
  repository_id: number;
}

interface RepositoryProbeRow {
  id: number;
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

function integerArray(values: number[]): SQL {
  if (values.length === 0) {
    return sql`ARRAY[]::integer[]`;
  }

  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::integer[]`;
}

function eligibleGenerationCtes(params: {
  eligibleBefore: string;
  keepPerRepository: number;
  repositoryIds: number[];
  generationBatchSize: number;
  perRepositoryGenerationBatchSize: number;
}): SQL {
  const keepFloorOffset = params.keepPerRepository - 1;

  return sql`
    repository_probe_ids AS MATERIALIZED (
      SELECT probe.id
      FROM unnest(${integerArray(params.repositoryIds)})
        WITH ORDINALITY AS probe(id, probe_order)
      ORDER BY probe.probe_order
    ),
    eligible_repositories AS MATERIALIZED (
      SELECT repository.id,
             repository.active_index_generation_id,
             keep_floor.superseded_at AS keep_floor_superseded_at,
             keep_floor.created_at AS keep_floor_created_at,
             keep_floor.id AS keep_floor_id
      FROM repository_probe_ids probe
      INNER JOIN knowledge_repositories repository
        ON repository.id = probe.id
      CROSS JOIN LATERAL (
        SELECT kept_generation.superseded_at,
               kept_generation.created_at,
               kept_generation.id
        FROM repository_index_generations kept_generation
        WHERE kept_generation.repository_id = repository.id
          AND kept_generation.status = 'superseded'
        ORDER BY kept_generation.superseded_at DESC,
                 kept_generation.created_at DESC,
                 kept_generation.id DESC
        OFFSET ${keepFloorOffset}
        LIMIT 1
      ) keep_floor
      CROSS JOIN LATERAL (
        SELECT candidate_generation.superseded_at,
               candidate_generation.created_at,
               candidate_generation.id
        FROM repository_index_generations candidate_generation
        WHERE candidate_generation.repository_id = repository.id
          AND candidate_generation.status = 'superseded'
          AND candidate_generation.superseded_at < ${params.eligibleBefore}::timestamptz
          AND (candidate_generation.superseded_at,
               candidate_generation.created_at,
               candidate_generation.id) <
              (keep_floor.superseded_at, keep_floor.created_at, keep_floor.id)
          AND candidate_generation.id IS DISTINCT FROM repository.active_index_generation_id
          AND NOT EXISTS (
            SELECT 1
            FROM knowledge_repositories active_repository
            WHERE active_repository.active_index_generation_id = candidate_generation.id
          )
        ORDER BY candidate_generation.superseded_at,
                 candidate_generation.created_at,
                 candidate_generation.id
        LIMIT 1
      ) oldest_candidate
      ORDER BY oldest_candidate.superseded_at,
               oldest_candidate.created_at,
               oldest_candidate.id,
               repository.id
      FOR UPDATE OF repository SKIP LOCKED
      LIMIT ${params.repositoryIds.length}
    ),
    eligible_generations AS MATERIALIZED (
      SELECT generation.id
      FROM eligible_repositories repository
      CROSS JOIN LATERAL (
        SELECT candidate_generation.id,
               candidate_generation.superseded_at,
               candidate_generation.created_at
        FROM repository_index_generations candidate_generation
        WHERE candidate_generation.repository_id = repository.id
          AND candidate_generation.status = 'superseded'
          AND candidate_generation.superseded_at < ${params.eligibleBefore}::timestamptz
          AND (candidate_generation.superseded_at,
               candidate_generation.created_at,
               candidate_generation.id) <
              (repository.keep_floor_superseded_at,
               repository.keep_floor_created_at,
               repository.keep_floor_id)
          AND candidate_generation.id IS DISTINCT FROM repository.active_index_generation_id
          AND NOT EXISTS (
            SELECT 1
            FROM knowledge_repositories active_repository
            WHERE active_repository.active_index_generation_id = candidate_generation.id
          )
        ORDER BY candidate_generation.superseded_at,
                 candidate_generation.created_at,
                 candidate_generation.id
        FOR UPDATE OF candidate_generation SKIP LOCKED
        LIMIT ${params.perRepositoryGenerationBatchSize}
      ) generation
      ORDER BY generation.superseded_at,
               generation.created_at,
               generation.id,
               repository.id
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
 * work on low repository IDs cannot starve older garbage elsewhere. A
 * persisted existing-key cursor makes each rotating repository probe bounded
 * by the live repository count even when IDs are sparse, while a
 * per-repository generation cap prevents one backlog from consuming the
 * entire global batch. The owner row lock stabilizes every supported pointer
 * update; the global pointer guard additionally fails closed on pre-existing
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
  const perRepositoryGenerationBatchSize = requirePositiveInteger(
    options.perRepositoryGenerationBatchSize ??
      GENERATION_GC_PER_REPOSITORY_BATCH,
    "perRepositoryGenerationBatchSize",
  );
  const collectionNow = options.now ?? new Date();
  const eligibleBefore = new Date(
    collectionNow.getTime() - retentionHours * 60 * 60_000,
  ).toISOString();
  return executeTransaction(
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO settings (key, value, description, category, is_secret)
        VALUES (
          ${GENERATION_GC_CURSOR_SETTING_KEY},
          '0',
          'Internal checkpoint: last repository ID probed by generation retention',
          'repositories',
          false
        )
        ON CONFLICT (key) DO NOTHING
      `);

      const cursorResult = await tx.execute(sql`
        SELECT CASE
                 WHEN value ~ '^[0-9]{1,10}$'
                   THEN LEAST(value::numeric, 2147483647)::integer
                 ELSE 0
               END AS repository_id
        FROM settings
        WHERE key = ${GENERATION_GC_CURSOR_SETTING_KEY}
        FOR UPDATE
      `);
      const [cursorRow] = toPgRows<RepositoryProbeCursorRow>(cursorResult);
      const repositoryProbeCursor = cursorRow?.repository_id ?? 0;

      const probeResult = await tx.execute(sql`
        WITH forward_probe AS MATERIALIZED (
          SELECT repository.id, 0 AS probe_segment
          FROM knowledge_repositories repository
          WHERE repository.id > ${repositoryProbeCursor}
          ORDER BY repository.id
          LIMIT ${repositoryBatchSize}
        ),
        wrapped_probe AS MATERIALIZED (
          SELECT repository.id, 1 AS probe_segment
          FROM knowledge_repositories repository
          WHERE repository.id <= ${repositoryProbeCursor}
          ORDER BY repository.id
          LIMIT ${repositoryBatchSize}
        )
        SELECT probe.id
        FROM (
          SELECT * FROM forward_probe
          UNION ALL
          SELECT * FROM wrapped_probe
        ) probe
        ORDER BY probe.probe_segment, probe.id
        LIMIT ${repositoryBatchSize}
      `);
      const repositoryIds = toPgRows<RepositoryProbeRow>(probeResult).map(
        (row) => row.id,
      );

      // Keep the phases as sequential statements: sibling data-modifying CTEs
      // share one snapshot, so a combined statement would not see chunk deletes
      // when deciding whether a generation is childless.
      const chunksResult = await tx.execute(sql`
        WITH ${eligibleGenerationCtes({
          eligibleBefore,
          keepPerRepository,
          repositoryIds,
          generationBatchSize,
          perRepositoryGenerationBatchSize,
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
          repositoryIds,
          generationBatchSize,
          perRepositoryGenerationBatchSize,
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

      const lastRepositoryId = repositoryIds.at(-1);
      if (lastRepositoryId !== undefined) {
        await tx.execute(sql`
          UPDATE settings
          SET value = ${lastRepositoryId.toString()},
              updated_at = statement_timestamp()
          WHERE key = ${GENERATION_GC_CURSOR_SETTING_KEY}
        `);
      }

      return {
        chunksDeleted: deletedCount(chunksResult),
        generationsDeleted: deletedCount(generationsResult),
      };
    },
    "contentPlatform.collectSupersededRepositoryGenerations",
  );
}
