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

export type EmbeddingModality =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'table';

export interface EmbeddingMessage {
  itemId: number;
  generationId?: string;
  chunkIds: number[];
  texts: string[];
  modalities?: EmbeddingModality[];
  visualSources?: Array<{
    objectKey: string;
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  } | null>;
  activationOnly?: boolean;
}

const EMBEDDING_MODALITIES = new Set<EmbeddingModality>([
  'text',
  'image',
  'audio',
  'video',
  'table',
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate malformed SQS input before model or database work begins. */
export function assertValidEmbeddingMessage(
  value: unknown
): asserts value is EmbeddingMessage {
  if (!value || typeof value !== 'object') {
    throw new Error('Embedding message must be an object');
  }
  const message = value as Record<string, unknown>;
  const itemId = message.itemId;
  const generationId = message.generationId;
  const chunkIds = message.chunkIds;
  const texts = message.texts;
  const modalities = message.modalities;
  const visualSources = message.visualSources;
  const activationOnly = message.activationOnly === true;
  if (!Number.isSafeInteger(itemId) || Number(itemId) <= 0) {
    throw new Error('Embedding message requires a positive item id');
  }
  if (
    generationId != null &&
    (typeof generationId !== 'string' || !UUID_PATTERN.test(generationId))
  ) {
    throw new Error('Embedding message generation id must be a UUID');
  }
  if (!Array.isArray(chunkIds) || !Array.isArray(texts)) {
    throw new Error('Embedding message requires chunk and text arrays');
  }
  if (activationOnly) {
    if (!generationId) {
      throw new Error('Embedding activation message requires a generation id');
    }
    if (chunkIds.length !== 0 || texts.length !== 0) {
      throw new Error('Embedding activation message must not contain chunk work');
    }
    if (
      (modalities != null && (!Array.isArray(modalities) || modalities.length !== 0)) ||
      (visualSources != null &&
        (!Array.isArray(visualSources) || visualSources.length !== 0))
    ) {
      throw new Error('Embedding activation message must not contain vector inputs');
    }
    return;
  }
  if (
    chunkIds.length === 0 ||
    chunkIds.length !== texts.length ||
    !chunkIds.every(
      (chunkId) => Number.isSafeInteger(chunkId) && Number(chunkId) > 0
    ) ||
    !texts.every((text) => typeof text === 'string') ||
    (modalities != null &&
      (!Array.isArray(modalities) ||
        modalities.length !== chunkIds.length ||
        !modalities.every(
          (modality) =>
            typeof modality === 'string' &&
            EMBEDDING_MODALITIES.has(modality as EmbeddingModality)
        ))) ||
    (visualSources != null &&
      (!Array.isArray(visualSources) || visualSources.length !== chunkIds.length))
  ) {
    throw new Error('Embedding message has invalid or mismatched chunk data');
  }
}

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
