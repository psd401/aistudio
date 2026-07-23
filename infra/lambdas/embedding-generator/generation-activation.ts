import { sql, type SQL } from 'drizzle-orm';

export interface GenerationActivationResult {
  repository_id: number;
  embedded_item_count: number;
}

export interface GenerationActivationPlan {
  lockRepository: SQL;
  supersedeCurrent: SQL;
  activateTarget: SQL;
  publishTarget: SQL;
}

export type GenerationActivationExecutor = (
  plan: GenerationActivationPlan,
) => Promise<GenerationActivationResult[]>;

/**
 * Atomically supersede the serving generation, activate the fully embedded
 * generation, move the repository pointer, and mark every included item ready.
 * A stale superseded generation is a safe no-op.
 *
 * The statements must run sequentially in one transaction. PostgreSQL's partial
 * unique index for one active generation is immediate, so a single multi-row
 * CASE update can nondeterministically activate the target before it supersedes
 * the old row. The repository lock also serializes duplicate final SQS records.
 */
export async function activateCompletedGeneration(
  generationId: string,
  execute: GenerationActivationExecutor,
): Promise<GenerationActivationResult | null> {
  const eligibleTarget = sql`
    SELECT generation.id, generation.repository_id
    FROM repository_index_generations generation
    JOIN knowledge_repositories target_repository
      ON target_repository.id = generation.repository_id
    WHERE generation.id = ${generationId}::uuid
      AND generation.status IN ('building', 'active')
      AND target_repository.lifecycle_status = 'active'
      AND (
        target_repository.expires_at IS NULL
        OR target_repository.expires_at > now()
      )
      AND EXISTS (
        SELECT 1
        FROM repository_item_chunks chunk
        WHERE chunk.index_generation_id = generation.id
      )
      AND NOT EXISTS (
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
      AND NOT EXISTS (
        SELECT 1
        FROM repository_item_chunks chunk
        JOIN repository_items item ON item.id = chunk.item_id
        WHERE chunk.index_generation_id = generation.id
          AND item.lifecycle_status <> 'active'
      )
  `;

  const rows = await execute({
    lockRepository: sql`
      SELECT repository.id
      FROM knowledge_repositories repository
      JOIN repository_index_generations generation
        ON generation.repository_id = repository.id
      WHERE generation.id = ${generationId}::uuid
      FOR UPDATE OF repository
    `,
    supersedeCurrent: sql`
      UPDATE repository_index_generations generation
      SET status = 'superseded'
      WHERE generation.status = 'active'
        AND generation.id <> ${generationId}::uuid
        AND generation.repository_id = (
          SELECT target.repository_id FROM (${eligibleTarget}) target
        )
    `,
    // Defense in depth: the preceding statement already supersedes the current
    // generation under the repository lock, but retain this invariant check if
    // the ordered activation plan is ever reused by another executor.
    activateTarget: sql`
      UPDATE repository_index_generations generation
      SET status = 'active',
          published_at = COALESCE(generation.published_at, now())
      WHERE generation.id = ${generationId}::uuid
        AND EXISTS (
          SELECT 1 FROM (${eligibleTarget}) target
          WHERE target.id = generation.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM repository_index_generations active_generation
          WHERE active_generation.repository_id = generation.repository_id
            AND active_generation.status = 'active'
            AND active_generation.id <> generation.id
        )
    `,
    publishTarget: sql`
      WITH repository_switch AS (
        UPDATE knowledge_repositories repository
        SET active_index_generation_id = ${generationId}::uuid,
            updated_at = now()
        WHERE repository.id = (
          SELECT generation.repository_id
          FROM (${eligibleTarget}) target
          JOIN repository_index_generations generation
            ON generation.id = target.id
          WHERE generation.status = 'active'
        )
          AND repository.lifecycle_status = 'active'
          AND (
            repository.expires_at IS NULL
            OR repository.expires_at > now()
          )
        RETURNING repository.id
      ), embedded_items AS (
        UPDATE repository_items item
        SET processing_status = 'embedded',
            processing_error = NULL,
            updated_at = now()
        WHERE item.id IN (
          SELECT DISTINCT chunk.item_id
          FROM repository_item_chunks chunk
          WHERE chunk.index_generation_id = ${generationId}::uuid
        )
          AND item.lifecycle_status = 'active'
          AND EXISTS (SELECT 1 FROM repository_switch)
        RETURNING item.id
      )
      SELECT
        repository_switch.id::integer AS repository_id,
        (SELECT count(*)::integer FROM embedded_items) AS embedded_item_count
      FROM repository_switch
    `,
  });
  return rows[0] ?? null;
}
