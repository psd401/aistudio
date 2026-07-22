-- Deterministic repository fixture for unified-content authenticated E2E.
-- Idempotent by the metadata marker; owned by the standard seeded administrator.

INSERT INTO knowledge_repositories (
  name,
  description,
  owner_id,
  is_public,
  repository_kind,
  lifecycle_status,
  metadata
)
SELECT
  'E2E Unified Content Repository',
  'Repository upload contract fixture',
  u.id,
  false,
  'durable',
  'active',
  '{"e2eFixture":"unified-content"}'::jsonb
FROM users u
WHERE u.cognito_sub = 'e2e-test-user'
  AND NOT EXISTS (
    SELECT 1
    FROM knowledge_repositories r
    WHERE r.metadata ->> 'e2eFixture' = 'unified-content'
  );

-- A deterministic terminal item proves that Repository Manager projects the
-- canonical failure and that its Retry action resets the durable job/version.
WITH fixture_context AS (
  SELECT r.id AS repository_id, u.id AS user_id
  FROM knowledge_repositories r
  JOIN users u ON u.cognito_sub = 'e2e-test-user'
  WHERE r.metadata ->> 'e2eFixture' = 'unified-content'
  LIMIT 1
)
INSERT INTO repository_items (
  repository_id,
  type,
  name,
  source,
  source_external_id,
  lifecycle_status,
  processing_status,
  processing_error,
  metadata
)
SELECT
  fixture_context.repository_id,
  'document',
  'E2E failed processing fixture',
  'repositories/' || fixture_context.repository_id ||
    '/77777777-7777-4777-8777-777777777777/retry.pdf',
  'e2e-unified-content-terminal-retry',
  'active',
  'failed',
  'Simulated terminal processing failure',
  '{"e2eFixture":"unified-content-terminal-retry"}'::jsonb
FROM fixture_context
WHERE NOT EXISTS (
  SELECT 1
  FROM repository_items item
  WHERE item.source_external_id = 'e2e-unified-content-terminal-retry'
);

WITH fixture_item AS (
  SELECT item.id, item.repository_id, u.id AS user_id
  FROM repository_items item
  JOIN knowledge_repositories repository ON repository.id = item.repository_id
  JOIN users u ON u.cognito_sub = 'e2e-test-user'
  WHERE item.source_external_id = 'e2e-unified-content-terminal-retry'
    AND repository.metadata ->> 'e2eFixture' = 'unified-content'
  LIMIT 1
)
INSERT INTO repository_item_versions (
  id,
  item_id,
  version_number,
  source_kind,
  source_revision,
  object_key,
  declared_content_type,
  byte_size,
  storage_status,
  inspection_status,
  processing_status,
  created_by
)
SELECT
  '77777777-7777-4777-8777-777777777778'::uuid,
  fixture_item.id,
  1,
  'upload',
  'e2e-terminal-retry',
  'repositories/' || fixture_item.repository_id ||
    '/77777777-7777-4777-8777-777777777777/retry.pdf',
  'application/pdf',
  128,
  'quarantined',
  'error',
  'failed',
  fixture_item.user_id
FROM fixture_item
ON CONFLICT (id) DO NOTHING;

UPDATE repository_items
SET current_version_id = '77777777-7777-4777-8777-777777777778'::uuid,
    processing_status = 'failed',
    processing_error = 'Simulated terminal processing failure',
    updated_at = now()
WHERE source_external_id = 'e2e-unified-content-terminal-retry';

INSERT INTO repository_processing_jobs (
  id,
  item_version_id,
  stage,
  status,
  idempotency_key,
  attempt,
  max_attempts,
  last_error_code,
  last_error_message,
  finished_at
)
VALUES (
  '77777777-7777-4777-8777-777777777779'::uuid,
  '77777777-7777-4777-8777-777777777778'::uuid,
  'inspect',
  'failed',
  'e2e-terminal-retry:inspect',
  5,
  5,
  'E2E_TERMINAL_FAILURE',
  'Simulated terminal processing failure',
  now()
)
ON CONFLICT (id) DO UPDATE
SET status = 'failed',
    attempt = 5,
    max_attempts = 5,
    available_at = now(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = 'E2E_TERMINAL_FAILURE',
    last_error_message = 'Simulated terminal processing failure',
    finished_at = now(),
    updated_at = now();
