-- Migration 174: quarantine inspect jobs exhausted by the pre-sanitizer
-- embedding dispatch runtime. Match only the two known transient signatures;
-- repository identity is deliberately not part of recovery eligibility.

UPDATE repository_processing_jobs job
SET status = 'cancelled',
    attempt = 0,
    max_attempts = 5,
    available_at = 'infinity'::timestamptz,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = 'POST_DEPLOY_RECOVERY_QUARANTINED',
    last_error_message = 'Awaiting the sanitized embedding dispatch runtime',
    post_deploy_recovery = 'content-message-sanitizer-v1',
    metrics = '{"postDeployRecovery":"content-message-sanitizer-v1"}'::jsonb,
    started_at = NULL,
    finished_at = now(),
    updated_at = now()
WHERE job.stage = 'inspect'
  AND job.status = 'failed'
  AND job.attempt >= job.max_attempts
  AND (
    job.last_error_message LIKE '%set of allowed characters is%'
    OR job.last_error_message LIKE 'Failed query:%repository_index_generations%'
  )
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
