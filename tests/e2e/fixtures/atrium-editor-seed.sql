-- Atrium Epic #1059 completion — editor/artifact functional-E2E seed
--
-- Seeds two objects OWNED BY the admin (e2e-test-user) for the gated functional
-- specs:
--
--  1. A private DOCUMENT (atrium-editor-e2e) that
--     tests/e2e/atrium-editor-rail.spec.ts opens in the real collaborative
--     editor to type two lines and assert the green (human) provenance rail —
--     the previously un-automated editor/rail leg of the reference E2E. No
--     publication, S3 blob, or pre-seeded Y.Doc state is required: the collab
--     server initializes doc state on first connect, and typing creates the
--     human-authored blocks the spec asserts.
--
--  2. A private ARTIFACT (atrium-artifact-e2e) with a small INLINE body (no S3
--     needed) that the gated block in tests/e2e/atrium-artifact.guard.spec.ts
--     opens to assert the sandbox iframe's runtime isolation attributes
--     (sandbox="allow-scripts", allow="").
--
-- Idempotent (ON CONFLICT resets the baseline), safe to re-run. Apply to the
-- local dev DB:
--
--   docker exec -i aistudio-postgres psql -U postgres -d aistudio \
--     < tests/e2e/fixtures/atrium-editor-seed.sql

-- 1. The editor document -----------------------------------------------------

INSERT INTO content_objects (
  id, kind, title, slug, owner_user_id, created_by_actor, visibility_level, status
)
SELECT
  'a7100000-0000-4000-8000-000000006060', 'document', 'Editor Rail E2E Doc',
  'atrium-editor-e2e',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'human', 'private', 'draft'
ON CONFLICT (slug) DO UPDATE
  SET visibility_level = 'private', status = EXCLUDED.status;

INSERT INTO content_versions (
  id, object_id, version_number, author_actor, author_user_id, body_format,
  body_location, summary
)
SELECT
  'a7100000-0000-4000-8000-0000000060a1', 'a7100000-0000-4000-8000-000000006060',
  1, 'human', (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'markdown', 'proof', 'seed v1'
ON CONFLICT (object_id, version_number) DO NOTHING;

UPDATE content_objects
  SET current_version_id = 'a7100000-0000-4000-8000-0000000060a1'
  WHERE id = 'a7100000-0000-4000-8000-000000006060';

-- 2. The inline artifact -----------------------------------------------------

INSERT INTO content_objects (
  id, kind, title, slug, owner_user_id, created_by_actor, visibility_level, status
)
SELECT
  'a7100000-0000-4000-8000-000000007070', 'artifact', 'Sandbox Attribute E2E Artifact',
  'atrium-artifact-e2e',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'human', 'private', 'draft'
ON CONFLICT (slug) DO UPDATE
  SET visibility_level = 'private', status = EXCLUDED.status;

-- Inline body (<= 4096 bytes -> body_location = 'inline'), so the canvas loads
-- the code without S3.
INSERT INTO content_versions (
  id, object_id, version_number, author_actor, author_user_id, body_format,
  body_location, body_inline, summary
)
SELECT
  'a7100000-0000-4000-8000-0000000070a1', 'a7100000-0000-4000-8000-000000007070',
  1, 'human', (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'html', 'inline',
  '<!doctype html><html><body><h1>Sandbox attribute E2E</h1></body></html>',
  'seed v1'
ON CONFLICT (object_id, version_number) DO NOTHING;

UPDATE content_objects
  SET current_version_id = 'a7100000-0000-4000-8000-0000000070a1'
  WHERE id = 'a7100000-0000-4000-8000-000000007070';
