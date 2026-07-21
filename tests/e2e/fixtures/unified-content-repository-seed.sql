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
