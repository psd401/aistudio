-- Deterministic repository fixture for unified-content authenticated E2E.
-- Idempotent by the metadata marker; owned by the standard seeded administrator.

-- Dedicated repository reader. It has the UI capability needed to reach
-- /repositories but is not an administrator, so repository_access remains the
-- exact source of its per-repository read authority.
INSERT INTO users (email, first_name, last_name, cognito_sub)
VALUES (
  'repository-reader@example.com',
  'Repository',
  'Reader',
  'e2e-repository-reader'
)
ON CONFLICT (cognito_sub) DO UPDATE
SET email = EXCLUDED.email,
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name;

INSERT INTO roles (name, description, is_system)
SELECT
  'e2e-repository-reader',
  'Authenticated E2E role with repository UI access but no administrator override',
  false
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE name = 'e2e-repository-reader'
);

INSERT INTO user_roles (user_id, role_id)
SELECT reader.id, role.id
FROM users reader
JOIN roles role ON role.name = 'e2e-repository-reader'
WHERE reader.cognito_sub = 'e2e-repository-reader'
ON CONFLICT (user_id, role_id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT role.id, capability.id
FROM roles role
JOIN capabilities capability
  ON capability.identifier = 'knowledge-repositories'
WHERE role.name = 'e2e-repository-reader'
ON CONFLICT (role_id, capability_id) DO NOTHING;

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

-- A second private repository is intentionally NOT shared. Together with the
-- explicit user grant below it gives the product-migration E2E a deterministic
-- exact-ACL boundary: staff can see the shared fixture but not this owner-only
-- fixture.
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
  'E2E Owner Only Repository',
  'Private repository that must not appear for the staff fixture',
  u.id,
  false,
  'durable',
  'active',
  '{"e2eFixture":"unified-content-owner-only"}'::jsonb
FROM users u
WHERE u.cognito_sub = 'e2e-test-user'
  AND NOT EXISTS (
    SELECT 1
    FROM knowledge_repositories r
    WHERE r.metadata ->> 'e2eFixture' = 'unified-content-owner-only'
  );

-- Grant the dedicated reader direct read access to exactly the primary
-- repository. The NOT EXISTS predicate keeps the fixture idempotent even though
-- repository_access historically has no composite unique constraint.
INSERT INTO repository_access (repository_id, user_id, role_id)
SELECT repository.id, reader.id, NULL
FROM knowledge_repositories repository
JOIN users reader ON reader.cognito_sub = 'e2e-repository-reader'
WHERE repository.metadata ->> 'e2eFixture' = 'unified-content'
  AND NOT EXISTS (
    SELECT 1
    FROM repository_access access
    WHERE access.repository_id = repository.id
      AND access.user_id = reader.id
      AND access.role_id IS NULL
  );

-- Assistant Architect is a staff-default product surface. Grant the standard
-- seeded staff user the same shared repository directly so the E2E proves the
-- picker uses executor ACLs without relying on an administrator override.
INSERT INTO repository_access (repository_id, user_id, role_id)
SELECT repository.id, staff.id, NULL
FROM knowledge_repositories repository
JOIN users staff ON staff.cognito_sub = 'e2e-staff-user'
WHERE repository.metadata ->> 'e2eFixture' = 'unified-content'
  AND NOT EXISTS (
    SELECT 1
    FROM repository_access access
    WHERE access.repository_id = repository.id
      AND access.user_id = staff.id
      AND access.role_id IS NULL
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
  1,
  20,
  'E2E_TERMINAL_FAILURE',
  'Simulated terminal processing failure',
  now()
)
ON CONFLICT (id) DO UPDATE
SET status = 'failed',
    attempt = 1,
    max_attempts = 20,
    available_at = now(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = 'E2E_TERMINAL_FAILURE',
    last_error_message = 'Simulated terminal processing failure',
    metrics = '{"textractJobId":"stale-e2e-job","waitReason":"AWAITING_OCR"}'::jsonb,
    started_at = now(),
    finished_at = now(),
    updated_at = now();
