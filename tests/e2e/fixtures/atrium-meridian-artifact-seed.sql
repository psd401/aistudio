-- Atrium Meridian slice D — artifact viewer + embed functional-E2E seed
--
-- Seeds, all OWNED BY the admin (e2e-test-user) so the minted admin session gets
-- canEdit/manage rights, for tests/e2e/atrium-meridian-artifact.spec.ts:
--
--  1. A private ARTIFACT (atrium-meridian-artifact) with a small INLINE body (no S3
--     needed — the canvas + embed NodeView load code from body_inline) that the
--     spec opens to assert the Meridian viewer chrome (topbar, ● LIVE ARTIFACT
--     pill, 300px metadata rail) and that the embed picker can insert it.
--
--  2. A private DOCUMENT (atrium-meridian-embed-doc) the spec opens in the editor
--     to insert the artifact as an embedded-artifact block via the ✦ embed picker.
--     Its live Y.Doc initializes on first collab connect (no S3 / pre-seeded state
--     required), so the spec can type + insert without S3.
--
--  3. A content_embed_links row (doc #2 embeds artifact #1) so the artifact viewer's
--     "EMBEDDED IN" rail card lists the document — the backlink leg, seeded directly
--     (the snapshot-driven backlink write needs S3, which local dev lacks).
--
-- Idempotent (ON CONFLICT), safe to re-run. Apply to the local dev DB:
--
--   docker exec -i aistudio-postgres psql -U postgres -d aistudio \
--     < tests/e2e/fixtures/atrium-meridian-artifact-seed.sql

-- 1. The inline artifact -----------------------------------------------------

INSERT INTO content_objects (
  id, kind, title, slug, owner_user_id, created_by_actor, visibility_level, status
)
SELECT
  'a7100000-0000-4000-8000-00000000d001', 'artifact', 'Meridian Metrics Artifact',
  'atrium-meridian-artifact',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'agent', 'private', 'draft'
ON CONFLICT (slug) DO UPDATE
  SET visibility_level = 'private', status = EXCLUDED.status,
      created_by_actor = 'agent';

INSERT INTO content_versions (
  id, object_id, version_number, author_actor, author_user_id, body_format,
  body_location, body_inline, summary
)
SELECT
  'a7100000-0000-4000-8000-00000000d0a1', 'a7100000-0000-4000-8000-00000000d001',
  1, 'human', (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'html', 'inline',
  '<!doctype html><html><body><h1>Meridian metrics</h1></body></html>',
  'seed v1'
ON CONFLICT (object_id, version_number) DO NOTHING;

UPDATE content_objects
  SET current_version_id = 'a7100000-0000-4000-8000-00000000d0a1'
  WHERE id = 'a7100000-0000-4000-8000-00000000d001';

-- 2. The embedding document --------------------------------------------------

INSERT INTO content_objects (
  id, kind, title, slug, owner_user_id, created_by_actor, visibility_level, status
)
SELECT
  'a7100000-0000-4000-8000-00000000d002', 'document', 'Meridian Embed Host Doc',
  'atrium-meridian-embed-doc',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'human', 'private', 'draft'
ON CONFLICT (slug) DO UPDATE
  SET visibility_level = 'private', status = EXCLUDED.status;

INSERT INTO content_versions (
  id, object_id, version_number, author_actor, author_user_id, body_format,
  body_location, summary
)
SELECT
  'a7100000-0000-4000-8000-00000000d0a2', 'a7100000-0000-4000-8000-00000000d002',
  1, 'human', (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'markdown', 'proof', 'seed v1'
ON CONFLICT (object_id, version_number) DO NOTHING;

UPDATE content_objects
  SET current_version_id = 'a7100000-0000-4000-8000-00000000d0a2'
  WHERE id = 'a7100000-0000-4000-8000-00000000d002';

-- 3. The backlink edge (doc #2 embeds artifact #1) for the "EMBEDDED IN" rail --

INSERT INTO content_embed_links (document_object_id, artifact_object_id)
VALUES (
  'a7100000-0000-4000-8000-00000000d002',
  'a7100000-0000-4000-8000-00000000d001'
)
ON CONFLICT (document_object_id, artifact_object_id) DO NOTHING;
