import { sql, type SQL } from 'drizzle-orm';

export interface GenerationActivationResult {
  repository_id: number;
  embedded_item_count: number;
}

export type GenerationActivationExecutor = (
  query: SQL,
) => Promise<GenerationActivationResult[]>;

/**
 * Atomically supersede the serving generation, activate the fully embedded
 * generation, move the repository pointer, and mark every included item ready.
 * A stale superseded generation is a safe no-op.
 */
export async function activateCompletedGeneration(
  generationId: string,
  execute: GenerationActivationExecutor,
): Promise<GenerationActivationResult | null> {
  const rows = await execute(sql`
    WITH target AS (
      SELECT id, repository_id
      FROM repository_index_generations generation
      WHERE generation.id = ${generationId}::uuid
        AND generation.status IN ('building', 'active')
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
    ), switched AS (
      UPDATE repository_index_generations generation
      SET
        status = CASE
          WHEN generation.id = ${generationId}::uuid THEN 'active'
          ELSE 'superseded'
        END,
        published_at = CASE
          WHEN generation.id = ${generationId}::uuid THEN now()
          ELSE generation.published_at
        END
      FROM target
      WHERE generation.repository_id = target.repository_id
        AND (
          generation.id = ${generationId}::uuid
          OR generation.status = 'active'
        )
      RETURNING target.repository_id, generation.id
    ), repository_switch AS (
      UPDATE knowledge_repositories repository
      SET active_index_generation_id = ${generationId}::uuid,
          updated_at = now()
      WHERE repository.id = (SELECT repository_id FROM target)
        AND EXISTS (
          SELECT 1 FROM switched WHERE id = ${generationId}::uuid
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
        AND EXISTS (SELECT 1 FROM repository_switch)
      RETURNING item.id
    )
    SELECT
      repository_switch.id::integer AS repository_id,
      (SELECT count(*)::integer FROM embedded_items) AS embedded_item_count
    FROM repository_switch
  `);
  return rows[0] ?? null;
}
