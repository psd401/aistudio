-- Migration 123: make unified-content recovery safe across CDK stack order.
--
-- Database migrations deploy before the processing Lambda during a full-stack
-- rollout. Never make recovery jobs runnable here: the previous Lambda version
-- could consume them with stale code. Instead mark a carefully bounded set as
-- cancelled/inert. The replacement worker recognizes the metrics marker and
-- atomically releases batches only after its own deployment is complete.

UPDATE repository_processing_jobs job
SET status = 'cancelled',
    attempt = 0,
    max_attempts = 5,
    available_at = 'infinity'::timestamptz,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = 'POST_DEPLOY_RECOVERY_QUARANTINED',
    last_error_message = 'Awaiting the unified-content runtime v2 deployment',
    metrics = '{"postDeployRecovery":"unified-content-runtime-v2"}'::jsonb,
    started_at = NULL,
    finished_at = now(),
    updated_at = now()
WHERE job.stage = 'inspect'
  AND (
    job.metrics ->> 'postDeployRecovery' = 'unified-content-runtime-v2'
    OR (
      job.status IN ('pending', 'queued', 'running', 'cancelled')
      AND job.last_error_code IN (
        'RECOVERED_BY_MIGRATION_122',
        'CONTENT_PLATFORM_DISABLED'
      )
    )
    OR (
      job.status = 'succeeded'
      AND EXISTS (
        SELECT 1
        FROM repository_items embedding_item
        WHERE embedding_item.current_version_id = job.item_version_id
          AND embedding_item.processing_status = 'embedding_failed'
      )
    )
  )
  AND job.last_error_code IS DISTINCT FROM 'SECURITY_INSPECTION_BLOCKED'
  AND EXISTS (
    SELECT 1
    FROM repository_items item
    JOIN repository_item_versions version
      ON version.id = item.current_version_id
    WHERE version.id = job.item_version_id
      AND item.lifecycle_status = 'active'
      AND version.storage_status <> 'blocked'
      AND version.inspection_status <> 'blocked'
      AND version.object_key ~ (
        '^repositories/' || item.repository_id::text ||
        '/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/[^/]+$'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM repository_item_chunks active_chunk
        JOIN knowledge_repositories repository
          ON repository.id = item.repository_id
        WHERE active_chunk.item_version_id = version.id
          AND active_chunk.index_generation_id = repository.active_index_generation_id
      )
  );
