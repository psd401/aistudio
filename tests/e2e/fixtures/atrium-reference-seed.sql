-- Atrium Phase 1 reference-E2E seed (#1051)
--
-- Seeds the published document + two building-scoped users the gated functional
-- spec (tests/e2e/atrium-document-reference.spec.ts) asserts against. Idempotent
-- (ON CONFLICT upserts), safe to re-run. Apply to the local dev DB:
--
--   docker exec -i aistudio-postgres psql -U postgres -d aistudio \
--     < tests/e2e/fixtures/atrium-reference-seed.sql
--
-- It does NOT write S3 source.md — the reader falls back to an empty article when
-- the blob is absent, which does not affect the visibility (200 vs 403) or
-- provenance-footer assertions. To exercise the rendered body too, snapshot a real
-- version through the editor/snapshot action (see the runbook).

-- 1. HS-staff user (in-building) + out-of-building user. cognito_sub is the unique
--    key. building drives the group/building visibility grant match.
INSERT INTO users (email, first_name, last_name, cognito_sub, building)
VALUES ('hs-staff@example.com', 'HS', 'Staff', 'e2e-hs-staff', 'High School')
ON CONFLICT (cognito_sub) DO UPDATE
  SET email = EXCLUDED.email, building = EXCLUDED.building;

INSERT INTO users (email, first_name, last_name, cognito_sub, building)
VALUES ('other-staff@example.com', 'Other', 'Staff', 'e2e-other-staff', 'Elementary')
ON CONFLICT (cognito_sub) DO UPDATE
  SET email = EXCLUDED.email, building = EXCLUDED.building;

-- Give both the staff role so they are authenticated staff (not admins, who would
-- bypass the audience check).
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u, roles r
WHERE u.cognito_sub IN ('e2e-hs-staff', 'e2e-other-staff') AND r.name = 'staff'
ON CONFLICT DO NOTHING;

-- 2. The content object: agent-created, group visibility, owned by the admin
--    (so the HS-staff user sees it ONLY via the building grant, and the
--    out-of-building user — neither owner nor admin nor in-building — is denied).
INSERT INTO content_objects (
  id, kind, title, slug, owner_user_id, created_by_actor, created_by_agent_id,
  visibility_level, status
)
SELECT
  'a7100000-0000-4000-8000-000000004040', 'document', 'Board Procedure 4040',
  'board-procedure-4040',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'agent',
  (SELECT id FROM agent_identities WHERE name = 'ship-reporter' LIMIT 1),
  'group', 'published'
ON CONFLICT (slug) DO UPDATE
  SET visibility_level = EXCLUDED.visibility_level, status = EXCLUDED.status;

-- 3. Versions: v1 agent-drafted, v2 human-reviewed (so the footer shows both).
INSERT INTO content_versions (
  id, object_id, version_number, author_actor, author_agent_id, body_format,
  body_location, summary
)
SELECT
  'a7100000-0000-4000-8000-0000000040a1', 'a7100000-0000-4000-8000-000000004040',
  1, 'agent', (SELECT id FROM agent_identities WHERE name = 'ship-reporter' LIMIT 1),
  'markdown', 'proof', 'Agent distilled one-pager'
ON CONFLICT (object_id, version_number) DO NOTHING;

INSERT INTO content_versions (
  id, object_id, version_number, author_actor, author_user_id, body_format,
  body_location, summary
)
SELECT
  'a7100000-0000-4000-8000-0000000040a2', 'a7100000-0000-4000-8000-000000004040',
  2, 'human', (SELECT id FROM users WHERE cognito_sub = 'e2e-hs-staff'),
  'markdown', 'proof', 'Human edited two lines'
ON CONFLICT (object_id, version_number) DO NOTHING;

-- Point the working head at v2.
UPDATE content_objects
  SET current_version_id = 'a7100000-0000-4000-8000-0000000040a2'
  WHERE id = 'a7100000-0000-4000-8000-000000004040';

-- 4. Visibility grant: building = High School.
INSERT INTO content_visibility_grants (object_id, grant_kind, grant_value)
VALUES ('a7100000-0000-4000-8000-000000004040', 'building', 'High School')
ON CONFLICT (object_id, grant_kind, grant_value) DO NOTHING;

-- 5. Publish v2 live on the intranet.
INSERT INTO content_publications (
  object_id, destination, published_version_id, status, published_by
)
SELECT
  'a7100000-0000-4000-8000-000000004040', 'intranet',
  'a7100000-0000-4000-8000-0000000040a2', 'live',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user')
ON CONFLICT (object_id, destination) DO UPDATE
  SET published_version_id = EXCLUDED.published_version_id, status = 'live';
