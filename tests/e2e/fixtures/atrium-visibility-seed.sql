-- Atrium Phase 3 visibility-E2E seed (#1053)
--
-- Seeds a private document OWNED BY the admin (e2e-test-user) that the gated
-- functional spec (tests/e2e/atrium-visibility-editor.spec.ts) drives through the
-- VisibilityChip editor. Idempotent (ON CONFLICT resets to a private baseline),
-- safe to re-run. Apply to the local dev DB:
--
--   docker exec -i aistudio-postgres psql -U postgres -d aistudio \
--     < tests/e2e/fixtures/atrium-visibility-seed.sql
--
-- The spec authenticates as the admin (owner -> canEdit) and sets the level via the
-- chip, so the object only needs to exist with a working head; no publication or S3
-- blob is required (the editor page renders the header + chip regardless).

INSERT INTO content_objects (
  id, kind, title, slug, owner_user_id, created_by_actor, visibility_level, status
)
SELECT
  'a7100000-0000-4000-8000-000000005050', 'document', 'Visibility E2E Doc',
  'atrium-visibility-e2e',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'human', 'private', 'draft'
ON CONFLICT (slug) DO UPDATE
  SET visibility_level = 'private', status = EXCLUDED.status;

INSERT INTO content_versions (
  id, object_id, version_number, author_actor, author_user_id, body_format,
  body_location, summary
)
SELECT
  'a7100000-0000-4000-8000-0000000050a1', 'a7100000-0000-4000-8000-000000005050',
  1, 'human', (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'markdown', 'proof', 'seed v1'
ON CONFLICT (object_id, version_number) DO NOTHING;

UPDATE content_objects
  SET current_version_id = 'a7100000-0000-4000-8000-0000000050a1'
  WHERE id = 'a7100000-0000-4000-8000-000000005050';

-- Clear any grants left by a prior run; the baseline level is private (no grants).
DELETE FROM content_visibility_grants
  WHERE object_id = 'a7100000-0000-4000-8000-000000005050';

-- Private-collection lock: a document filed in a PRIVATE collection (owner-bound,
-- `owner_user_id` set) owned by the admin. The service rejects every level but
-- `private` for such content, so the Share dialog must offer only Private and
-- explain why (prod 2026-10-23: "Failed to update visibility" with no reason).
INSERT INTO content_collections (
  id, name, slug, default_visibility_level, owner_user_id, inherit_grants
)
SELECT
  'a7100000-0000-4000-8000-00000000c506', 'Visibility E2E Private Collection',
  'e2e-visibility-private-collection', 'private',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'), false
ON CONFLICT (slug) DO UPDATE SET archived_at = NULL;

INSERT INTO content_objects (
  id, kind, title, slug, owner_user_id, created_by_actor, visibility_level, status,
  collection_id
)
SELECT
  'a7100000-0000-4000-8000-000000005051', 'document', 'Visibility E2E Private-Collection Doc',
  'atrium-visibility-private-collection-e2e',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'human', 'private', 'draft', 'a7100000-0000-4000-8000-00000000c506'
ON CONFLICT (slug) DO UPDATE
  SET visibility_level = 'private', status = EXCLUDED.status,
      collection_id = EXCLUDED.collection_id;

INSERT INTO content_versions (
  id, object_id, version_number, author_actor, author_user_id, body_format,
  body_location, summary
)
SELECT
  'a7100000-0000-4000-8000-0000000050a2', 'a7100000-0000-4000-8000-000000005051',
  1, 'human', (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'markdown', 'proof', 'seed v1'
ON CONFLICT (object_id, version_number) DO NOTHING;

UPDATE content_objects
  SET current_version_id = 'a7100000-0000-4000-8000-0000000050a2'
  WHERE id = 'a7100000-0000-4000-8000-000000005051';
