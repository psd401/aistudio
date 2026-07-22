import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  toPgRows,
} from "@/lib/db/drizzle-client";
import {
  repositoryIndexGenerations,
  type RepositoryIndexGenerationStatus,
} from "@/lib/db/schema";

export const INCOMPLETE_EMBEDDING_RECOVERY_BATCH_SIZE = 10;
export const INCOMPLETE_EMBEDDING_RECOVERY_INTERVAL_MINUTES = 10;
export const EMBEDDING_RECOVERY_MAX_ATTEMPTS = 3;

export interface IncompleteEmbeddingGeneration {
  id: string;
  visualEmbeddingEnabled: boolean;
  activationOnly: boolean;
  claimedAt: Date;
  recoveryAttempt: number;
  previousStatus: Exclude<RepositoryIndexGenerationStatus, "superseded">;
  previousErrorMessage: string | null;
}

export interface ClaimIncompleteEmbeddingGenerationOptions {
  now?: Date;
  intervalMinutes?: number;
}

export interface CanonicalEmbeddingDlqMessage {
  generationId: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Reject legacy or malformed DLQ bodies; they stay visible for diagnosis. */
export function parseCanonicalEmbeddingDlqMessage(
  body: string
): CanonicalEmbeddingDlqMessage | null {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    const itemId = value.itemId;
    const generationId = value.generationId;
    const chunkIds = value.chunkIds;
    const texts = value.texts;
    const activationOnly = value.activationOnly === true;
    if (
      !Number.isSafeInteger(itemId) ||
      Number(itemId) <= 0 ||
      typeof generationId !== "string" ||
      !UUID_PATTERN.test(generationId) ||
      !Array.isArray(chunkIds) ||
      (!activationOnly && chunkIds.length === 0) ||
      (activationOnly && chunkIds.length !== 0) ||
      !chunkIds.every(
        (chunkId) => Number.isSafeInteger(chunkId) && Number(chunkId) > 0
      ) ||
      !Array.isArray(texts) ||
      (activationOnly && texts.length !== 0) ||
      texts.length !== chunkIds.length ||
      !texts.every((text) => typeof text === "string")
    ) {
      return null;
    }
    return { generationId };
  } catch {
    return null;
  }
}

/**
 * A canonical DLQ record is obsolete after its generation completed, was
 * superseded/deleted, or a durable recovery dispatch was successfully queued.
 * Failed generations remain in the DLQ until the bounded recovery scheduler
 * reopens them, preserving a real alarm for exhausted failures.
 */
export async function canAcknowledgeCanonicalEmbeddingDlqMessage(
  generationId: string
): Promise<boolean> {
  const [generation] = await executeQuery(
    (db) =>
      db
        .select({
          status: repositoryIndexGenerations.status,
          recoveryQueuedAt:
            repositoryIndexGenerations.embeddingRecoveryQueuedAt,
          recoveryAttempts:
            repositoryIndexGenerations.embeddingRecoveryAttempts,
          missingChunkCount: sql<number>`(
            SELECT count(*)::integer
            FROM repository_item_chunks chunk
            WHERE chunk.index_generation_id = repository_index_generations.id
              AND (
                chunk.embedding IS NULL
                OR (
                  ${repositoryIndexGenerations.visualEmbeddingModel} IS NOT NULL
                  AND chunk.modality IN ('image', 'video')
                  AND chunk.visual_embedding IS NULL
                )
              )
          )`,
        })
        .from(repositoryIndexGenerations)
        .where(eq(repositoryIndexGenerations.id, generationId))
        .limit(1),
    "contentPlatform.embeddingDlqDisposition"
  );
  if (!generation || generation.status === "superseded") return true;
  if (generation.status === "failed") return false;
  if (generation.status === "active" && generation.missingChunkCount === 0) {
    return true;
  }
  if (
    generation.missingChunkCount > 0 &&
    generation.recoveryAttempts >= EMBEDDING_RECOVERY_MAX_ATTEMPTS
  ) {
    return false;
  }
  return generation.recoveryQueuedAt !== null;
}

/**
 * Claim incomplete building or active generations for bounded SQS redispatch,
 * and reopen the latest failed generation for a bounded automatic retry.
 * The timestamp prevents the one-minute scheduler from flooding duplicate
 * messages while an earlier batch is still running. Active generations remain
 * searchable while missing vectors are repaired in place.
 */
export async function claimIncompleteEmbeddingGenerations(
  options: ClaimIncompleteEmbeddingGenerationOptions = {}
): Promise<IncompleteEmbeddingGeneration[]> {
  const now = options.now ?? new Date();
  const intervalMinutes =
    options.intervalMinutes ?? INCOMPLETE_EMBEDDING_RECOVERY_INTERVAL_MINUTES;
  const eligibleBefore = new Date(
    now.getTime() - intervalMinutes * 60_000
  ).toISOString();
  const claimed = await executeTransaction(
    (tx) =>
      tx.execute(sql`
        WITH selected AS (
          SELECT generation.id,
                 generation.status AS previous_status,
                 generation.error_message AS previous_error_message
          FROM repository_index_generations generation
          WHERE generation.status IN ('building', 'active', 'failed')
            AND generation.embedding_model IS NOT NULL
            AND generation.embedding_recovery_attempts < ${EMBEDDING_RECOVERY_MAX_ATTEMPTS}
            AND (
              generation.status <> 'failed'
              OR (
                NOT EXISTS (
                  SELECT 1
                  FROM repository_index_generations newer_generation
                  WHERE newer_generation.repository_id = generation.repository_id
                    AND newer_generation.status IN ('building', 'active', 'failed')
                    AND (
                      newer_generation.created_at > generation.created_at
                      OR (
                        newer_generation.created_at = generation.created_at
                        AND newer_generation.id > generation.id
                      )
                    )
                )
              )
            )
            AND COALESCE(
              generation.embedding_recovery_queued_at,
              generation.created_at
            ) <= ${eligibleBefore}::timestamptz
            AND EXISTS (
              SELECT 1
              FROM repository_item_chunks owned_chunk
              WHERE owned_chunk.index_generation_id = generation.id
            )
            AND (
              -- A complete building generation can be stranded after model
              -- writes but before atomic activation. It needs an activation-
              -- only dispatch just as a failed generation does.
              generation.status IN ('building', 'failed')
              OR EXISTS (
              SELECT 1
              FROM repository_item_chunks chunk
              WHERE chunk.index_generation_id = generation.id
                AND (
                  chunk.embedding IS NULL
                  OR (
                    generation.visual_embedding_model IS NOT NULL
                    AND chunk.modality IN ('image', 'video')
                    AND chunk.visual_embedding IS NULL
                  )
                )
              )
            )
          ORDER BY
            COALESCE(
              generation.embedding_recovery_queued_at,
              generation.created_at
            ),
            generation.id
          FOR UPDATE OF generation SKIP LOCKED
          LIMIT ${INCOMPLETE_EMBEDDING_RECOVERY_BATCH_SIZE}
        )
        UPDATE repository_index_generations generation
        SET embedding_recovery_queued_at = ${now.toISOString()}::timestamptz,
            embedding_recovery_attempts = generation.embedding_recovery_attempts + 1,
            status = CASE
              WHEN generation.status = 'failed' THEN 'building'
              ELSE generation.status
            END,
            error_message = CASE
              WHEN generation.status = 'failed' THEN NULL
              ELSE generation.error_message
            END
        FROM selected
        WHERE generation.id = selected.id
        RETURNING
          generation.id,
          generation.embedding_recovery_attempts,
          selected.previous_status,
          selected.previous_error_message,
          (generation.visual_embedding_model IS NOT NULL) AS visual_embedding_enabled,
          NOT EXISTS (
            SELECT 1
            FROM repository_item_chunks chunk
            WHERE chunk.index_generation_id = generation.id
              AND (
                chunk.embedding IS NULL
                OR (
                  generation.visual_embedding_model IS NOT NULL
                  AND chunk.modality IN ('image', 'video')
                  AND chunk.visual_embedding IS NULL
                )
              )
          ) AS activation_only
      `),
    "contentPlatform.claimIncompleteEmbeddingGenerations"
  );
  return toPgRows<{
    id: string;
    embedding_recovery_attempts: number;
    previous_status: Exclude<RepositoryIndexGenerationStatus, "superseded">;
    previous_error_message: string | null;
    visual_embedding_enabled: boolean;
    activation_only: boolean;
  }>(claimed).map((row) => ({
    id: row.id,
    claimedAt: now,
    recoveryAttempt: row.embedding_recovery_attempts,
    previousStatus: row.previous_status,
    previousErrorMessage: row.previous_error_message,
    visualEmbeddingEnabled: row.visual_embedding_enabled,
    activationOnly: row.activation_only,
  }));
}

/**
 * Release a scheduler claim only when no SQS message was durably dispatched.
 *
 * The attempt remains consumed so a persistent queue/configuration outage is
 * bounded and eventually leaves an actionable exhausted state. Failed
 * generations are restored to their pre-claim state so a zero-dispatch error
 * cannot masquerade as active embedding work. The claim timestamp fences a
 * stale invocation from releasing a newer scheduler claim.
 */
export async function releaseIncompleteEmbeddingGenerationClaim(
  claim: IncompleteEmbeddingGeneration
): Promise<boolean> {
  const released = await executeQuery(
    (db) =>
      db
        .update(repositoryIndexGenerations)
        .set({
          embeddingRecoveryQueuedAt: null,
          status: claim.previousStatus,
          errorMessage: claim.previousErrorMessage,
        })
        .where(
          and(
            eq(repositoryIndexGenerations.id, claim.id),
            isNotNull(repositoryIndexGenerations.embeddingRecoveryQueuedAt),
            eq(
              repositoryIndexGenerations.embeddingRecoveryQueuedAt,
              claim.claimedAt
            ),
            eq(
              repositoryIndexGenerations.embeddingRecoveryAttempts,
              claim.recoveryAttempt
            )
          )
        )
        .returning({ id: repositoryIndexGenerations.id }),
    "contentPlatform.releaseIncompleteEmbeddingGenerationClaim"
  );
  return released.length === 1;
}
