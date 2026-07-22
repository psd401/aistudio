import { sql, type SQL } from 'drizzle-orm';

export type CanonicalGenerationStatus =
  | 'building'
  | 'active'
  | 'superseded'
  | 'failed';

export type GenerationFailureExecutor = (
  query: SQL,
) => Promise<Array<{ item_id: number }>>;

const DEFAULT_MAX_RECEIVE_COUNT = 3;

/** Stale generations must acknowledge queued batches without doing model work. */
export function shouldSkipCanonicalGeneration(
  status: CanonicalGenerationStatus
): boolean {
  return status === 'superseded' || status === 'failed';
}

/**
 * SQS moves a message to the embedding DLQ after the configured third failed
 * receive. Do not expose a terminal item failure while SQS still has a retry.
 */
export function isTerminalEmbeddingAttempt(
  approximateReceiveCount: string | undefined,
  maxReceiveCount = DEFAULT_MAX_RECEIVE_COUNT
): boolean {
  const receiveCount = Number.parseInt(approximateReceiveCount ?? '1', 10);
  return (
    Number.isSafeInteger(receiveCount) &&
    receiveCount >= Math.max(1, maxReceiveCount)
  );
}

/**
 * Fail only the current building generation. A batch from a generation that a
 * newer publication superseded is a safe no-op and cannot overwrite item state.
 * The previous active generation and repository serving pointer stay untouched.
 */
export async function failBuildingGeneration(
  input: {
    generationId: string;
    itemId: number;
    errorMessage: string;
  },
  execute: GenerationFailureExecutor
): Promise<boolean> {
  const rows = await execute(sql`
    WITH failed_generation AS (
      UPDATE repository_index_generations generation
      SET status = 'failed',
          error_message = ${input.errorMessage.slice(0, 4000)}
      WHERE generation.id = ${input.generationId}::uuid
        AND generation.status = 'building'
      RETURNING generation.id
    )
    UPDATE repository_items item
    SET processing_status = 'embedding_failed',
        processing_error = ${input.errorMessage.slice(0, 4000)},
        updated_at = now()
    WHERE item.id = ${input.itemId}
      AND EXISTS (SELECT 1 FROM failed_generation)
      AND EXISTS (
        SELECT 1
        FROM repository_item_chunks chunk
        WHERE chunk.index_generation_id = ${input.generationId}::uuid
          AND chunk.item_id = item.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM repository_item_chunks serving_chunk
        JOIN knowledge_repositories serving_repository
          ON serving_repository.id = item.repository_id
        WHERE serving_chunk.item_id = item.id
          AND serving_chunk.index_generation_id = serving_repository.active_index_generation_id
      )
    RETURNING item.id::integer AS item_id
  `);
  return rows.length > 0;
}
