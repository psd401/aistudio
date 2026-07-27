-- Migration 159: recover Unified Content work exhausted by an unbounded
-- embedding-worker connection storm.
--
-- The pre-fix SQS event source had no concurrency limit. During a repository
-- backfill it reached hundreds of concurrent VPC Lambdas, so Aurora connection
-- establishment timed out before processing or embedding queries could run.
-- Quarantine only the known transient signatures. The replacement scheduled
-- worker releases these rows after its 20-minute old-runtime drain window;
-- ordinary workers cannot claim them before that boundary.

UPDATE repository_processing_jobs job
SET status = 'cancelled',
    attempt = 0,
    max_attempts = 5,
    available_at = 'infinity'::timestamptz,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = 'POST_DEPLOY_RECOVERY_QUARANTINED',
    last_error_message = 'Awaiting the bounded embedding concurrency runtime',
    post_deploy_recovery = 'embedding-concurrency-v1',
    metrics = '{"postDeployRecovery":"embedding-concurrency-v1"}'::jsonb,
    started_at = NULL,
    finished_at = now(),
    updated_at = now()
WHERE job.stage = 'inspect'
  AND job.status = 'failed'
  AND job.last_error_code = 'RETRY_BUDGET_EXHAUSTED'
  AND job.last_error_message ILIKE 'Failed query:%repository_index_generations%'
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

-- Exhausted generations remain failed and keep their DLQ evidence visible.
-- The timestamp plus max attempt count is the durable old-worker fence.
UPDATE repository_index_generations generation
SET embedding_recovery_queued_at = now(),
    embedding_recovery_attempts = 3,
    error_message = concat(
      'embedding-concurrency-v1: ',
      COALESCE(generation.error_message, 'database connection timeout')
    )
WHERE generation.status = 'failed'
  AND generation.embedding_recovery_attempts >= 3
  AND generation.error_message ILIKE
    'Failed query:%FROM repository_index_generations%'
  AND EXISTS (
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
  );
