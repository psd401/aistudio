-- Migration 124: recover artifact-runtime failures and stale managed-service jobs.
--
-- Full CDK deployments migrate the database before replacing the processing
-- Lambda. Keep non-serving recovery work cancelled behind the durable handoff
-- marker until the new worker has outlived every old 15-minute invocation.
-- Active versions may also have intentional processor/embedding upgrades in
-- flight. Keep their serving generation searchable while the corrected worker
-- builds and atomically activates a replacement; never infer job completion
-- solely from the presence of old active chunks.

ALTER TABLE repository_index_generations
  ADD COLUMN IF NOT EXISTS embedding_recovery_queued_at timestamptz;

ALTER TABLE repository_index_generations
  ADD COLUMN IF NOT EXISTS embedding_recovery_attempts integer NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_repository_index_generations_embedding_recovery;

CREATE INDEX idx_repository_index_generations_embedding_recovery
  ON repository_index_generations (
    embedding_recovery_queued_at,
    embedding_recovery_attempts,
    created_at,
    id
  )
  WHERE status IN ('building', 'active', 'failed');

UPDATE repository_processing_jobs job
SET status = 'cancelled',
    attempt = 0,
    max_attempts = 5,
    available_at = 'infinity'::timestamptz,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = 'POST_DEPLOY_RECOVERY_QUARANTINED',
    last_error_message = 'Awaiting the corrected unified-content artifact runtime',
    post_deploy_recovery = 'unified-content-artifact-v3',
    metrics = '{"postDeployRecovery":"unified-content-artifact-v3"}'::jsonb,
    started_at = NULL,
    finished_at = now(),
    updated_at = now()
WHERE job.stage = 'inspect'
  AND job.status IN ('pending', 'queued', 'running', 'failed', 'cancelled')
  AND job.last_error_code IS DISTINCT FROM 'SECURITY_INSPECTION_BLOCKED'
  AND job.last_error_message ILIKE ANY (ARRAY[
    '%PDFParse%is not a constructor%',
    '%DOMMatrix is not defined%',
    '%@napi-rs/canvas%',
    '%Textract job does not match the normalized image artifact%'
  ])
  AND EXISTS (
    SELECT 1
    FROM repository_item_versions version
    JOIN repository_items item
      ON item.current_version_id = version.id
    WHERE version.id = job.item_version_id
      AND item.lifecycle_status = 'active'
      AND version.storage_status <> 'blocked'
      AND version.inspection_status <> 'blocked'
      AND version.object_key ~ (
        '^repositories/' || item.repository_id::text ||
        '/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/[^/]+$'
      )
  );

-- A known runtime failure during an active background rebuild must not make the
-- already-published snapshot disappear from retrieval. Restore only versions
-- proven to be in the repository's active generation; the inspect job remains
-- quarantined and will build a replacement after the drain window.
UPDATE repository_item_versions version
SET storage_status = 'available',
    inspection_status = CASE
      WHEN version.inspection_status = 'not_required' THEN 'not_required'
      ELSE 'clean'
    END,
    processing_status = 'completed'
WHERE EXISTS (
  SELECT 1
  FROM repository_processing_jobs job
  JOIN repository_items item
    ON item.current_version_id = version.id
  JOIN knowledge_repositories repository
    ON repository.id = item.repository_id
  JOIN repository_item_chunks active_chunk
    ON active_chunk.item_version_id = version.id
   AND active_chunk.index_generation_id = repository.active_index_generation_id
  WHERE job.item_version_id = version.id
    AND job.stage = 'inspect'
    AND job.post_deploy_recovery = 'unified-content-artifact-v3'
    AND item.lifecycle_status = 'active'
    AND version.storage_status <> 'blocked'
    AND version.inspection_status <> 'blocked'
);

UPDATE repository_items item
SET processing_status = 'embedded',
    processing_error = NULL,
    updated_at = now()
WHERE item.lifecycle_status = 'active'
  AND EXISTS (
    SELECT 1
    FROM repository_processing_jobs job
    JOIN repository_item_versions version
      ON version.id = job.item_version_id
     AND version.id = item.current_version_id
    JOIN knowledge_repositories repository
      ON repository.id = item.repository_id
    JOIN repository_item_chunks active_chunk
      ON active_chunk.item_version_id = version.id
     AND active_chunk.index_generation_id = repository.active_index_generation_id
    WHERE job.stage = 'inspect'
      AND job.post_deploy_recovery = 'unified-content-artifact-v3'
      AND version.storage_status <> 'blocked'
      AND version.inspection_status <> 'blocked'
  );
