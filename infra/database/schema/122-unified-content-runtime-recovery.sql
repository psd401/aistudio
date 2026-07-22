-- Migration 122: recover content stranded by the pre-hardening runtime.
--
-- Earlier workers could leave deterministic processor failures in `failed`
-- before their DB retry budget was exhausted, while embedding failures left a
-- generation `building` forever and only changed the legacy item status. The
-- corrected workers never create either state. Requeue the affected current
-- versions once so the deployment heals existing data without an AWS CLI or
-- direct database runbook.

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

-- Replay the durable inspect job for those embedding failures. Reprocessing
-- creates a new generation under the current provider descriptor and preserves
-- the previous active generation until the replacement is fully embedded.
UPDATE repository_processing_jobs job
   SET status = 'pending',
       attempt = 0,
       max_attempts = GREATEST(job.max_attempts, 5),
       available_at = now(),
       lease_owner = NULL,
       lease_expires_at = NULL,
       last_error_code = 'RECOVERED_BY_MIGRATION_122',
       last_error_message = NULL,
       finished_at = NULL,
       updated_at = now()
 WHERE job.status = 'succeeded'
   AND EXISTS (
     SELECT 1
       FROM repository_items item
      WHERE item.current_version_id = job.item_version_id
        AND item.processing_status = 'embedding_failed'
   );

-- Old processor failures were marked failed after each receive and therefore
-- were invisible to the pending-job sweep. Give current versions one fresh,
-- bounded budget; the corrected handler immediately closes permanent errors.
UPDATE repository_processing_jobs job
   SET status = 'pending',
       attempt = 0,
       max_attempts = GREATEST(job.max_attempts, 5),
       available_at = now(),
       lease_owner = NULL,
       lease_expires_at = NULL,
       last_error_code = 'RECOVERED_BY_MIGRATION_122',
       last_error_message = NULL,
       finished_at = NULL,
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
   );

UPDATE repository_item_versions version
   SET storage_status = 'quarantined',
       inspection_status = 'pending',
       processing_status = 'pending'
 WHERE EXISTS (
   SELECT 1
     FROM repository_processing_jobs job
    WHERE job.item_version_id = version.id
      AND job.status = 'pending'
      AND job.last_error_code = 'RECOVERED_BY_MIGRATION_122'
 );

UPDATE repository_items item
   SET processing_status = 'pending',
       processing_error = NULL,
       updated_at = now()
 WHERE EXISTS (
   SELECT 1
     FROM repository_processing_jobs job
    WHERE job.item_version_id = item.current_version_id
      AND job.status = 'pending'
      AND job.last_error_code = 'RECOVERED_BY_MIGRATION_122'
 );
