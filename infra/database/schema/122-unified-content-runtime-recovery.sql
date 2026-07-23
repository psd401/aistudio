-- Migration 122: recover content stranded by the pre-hardening runtime.
--
-- Earlier workers could leave deterministic processor failures in `failed`
-- before their DB retry budget was exhausted, while embedding failures left a
-- generation `building` forever and only changed the legacy item status. The
-- corrected workers never create either state. Quarantine the affected current
-- versions once so the replacement runtime, not a still-running old Lambda,
-- releases them after the processing stack update. Migration 123 repeats this
-- handoff for environments where the original migration 122 already ran.

-- A pre-hardening embedding failure cannot be resumed in-place because its SQS
-- record may already be in the DLQ. Retire only building generations that are
-- explicitly associated with a current item carrying the old terminal status.
UPDATE repository_index_generations generation
   SET status = 'failed',
       error_message = COALESCE(
         generation.error_message,
         'Recovered from a pre-hardening embedding failure by migration 122'
       )
 WHERE generation.status = 'building'
   AND EXISTS (
     SELECT 1
       FROM repository_item_chunks chunk
       JOIN repository_items item
         ON item.id = chunk.item_id
        AND item.current_version_id = chunk.item_version_id
      WHERE chunk.index_generation_id = generation.id
        AND item.processing_status = 'embedding_failed'
   );

-- Quarantine the durable inspect job for those embedding failures. `cancelled`
-- is intentionally terminal to every old worker, including stale SQS receives.
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
 WHERE job.status = 'succeeded'
   AND EXISTS (
     SELECT 1
       FROM repository_items item
       JOIN repository_item_versions version
         ON version.id = item.current_version_id
      WHERE version.id = job.item_version_id
        AND item.processing_status = 'embedding_failed'
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

-- Old processor failures were marked failed after each receive. Quarantine only
-- canonical, current, non-serving sources; invalid legacy keys require the UI
-- retry path to create a fresh immutable version in the corrected namespace.
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
 WHERE job.status = 'failed'
   AND job.attempt < job.max_attempts
   AND job.last_error_code IS DISTINCT FROM 'SECURITY_INSPECTION_BLOCKED'
   AND EXISTS (
     SELECT 1
       FROM repository_items item
       JOIN repository_item_versions version
         ON version.id = item.current_version_id
      WHERE version.id = job.item_version_id
        AND item.lifecycle_status = 'active'
        -- Never revive malware/policy-blocked content. Those terminal states
        -- require a new source version, not an automatic processing retry.
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
