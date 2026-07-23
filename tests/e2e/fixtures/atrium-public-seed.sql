-- Atrium Phase 7 public-reader E2E seed (#1057)
--
-- Seeds the objects the gated functional spec
-- (tests/e2e/atrium-public-reader.functional.spec.ts) asserts the anonymous
-- public reader (/p/[slug]) against. Idempotent (ON CONFLICT upserts), safe to
-- re-run. Apply to the local dev DB:
--
--   docker exec -i aistudio-postgres psql -U postgres -d aistudio \
--     < tests/e2e/fixtures/atrium-public-seed.sql
--
-- It does NOT write S3 source.md — the reader falls back to an empty article when
-- the blob is absent, which does not affect the visibility (200 vs 404) assertions.
--
-- Two objects:
--   (A) a PUBLIC document published live to public_web  -> /p/atrium-public-welcome renders (200)
--   (B) an INTERNAL document ALSO published live to public_web (the strict-gate
--       case) -> /p/atrium-internal-not-public 404s, because the public reader
--       gates on visibility_level='public', NOT merely on a live public_web row.

-- (A) Public document ---------------------------------------------------------
INSERT INTO content_objects (
  id, kind, title, slug, owner_user_id, created_by_actor,
  visibility_level, status
)
SELECT
  'a7700000-0000-4000-8000-000000000001', 'document', 'Public Welcome',
  'atrium-public-welcome',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'human', 'public', 'published'
ON CONFLICT (slug) DO UPDATE
  SET visibility_level = EXCLUDED.visibility_level, status = EXCLUDED.status;

INSERT INTO content_versions (
  id, object_id, version_number, author_actor, author_user_id, body_format,
  body_location, summary
)
SELECT
  'a7700000-0000-4000-8000-0000000001a1', 'a7700000-0000-4000-8000-000000000001',
  1, 'human', (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'markdown', 'proof', 'Public welcome page'
ON CONFLICT (object_id, version_number) DO NOTHING;

UPDATE content_objects
  SET current_version_id = 'a7700000-0000-4000-8000-0000000001a1'
  WHERE id = 'a7700000-0000-4000-8000-000000000001';

INSERT INTO content_publications (
  object_id, destination, published_version_id, status, published_by, external_ref
)
SELECT
  'a7700000-0000-4000-8000-000000000001', 'public_web',
  'a7700000-0000-4000-8000-0000000001a1', 'live',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  '/p/atrium-public-welcome'
ON CONFLICT (object_id, destination) DO UPDATE
  SET published_version_id = EXCLUDED.published_version_id, status = 'live',
      external_ref = EXCLUDED.external_ref;

-- (B) Internal document, live on public_web but NOT public (strict-gate case) --
INSERT INTO content_objects (
  id, kind, title, slug, owner_user_id, created_by_actor,
  visibility_level, status
)
SELECT
  'a7700000-0000-4000-8000-000000000002', 'document', 'Internal Not Public',
  'atrium-internal-not-public',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'human', 'internal', 'published'
ON CONFLICT (slug) DO UPDATE
  SET visibility_level = EXCLUDED.visibility_level, status = EXCLUDED.status;

INSERT INTO content_versions (
  id, object_id, version_number, author_actor, author_user_id, body_format,
  body_location, summary
)
SELECT
  'a7700000-0000-4000-8000-0000000002a1', 'a7700000-0000-4000-8000-000000000002',
  1, 'human', (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'markdown', 'proof', 'Internal page'
ON CONFLICT (object_id, version_number) DO NOTHING;

UPDATE content_objects
  SET current_version_id = 'a7700000-0000-4000-8000-0000000002a1'
  WHERE id = 'a7700000-0000-4000-8000-000000000002';

INSERT INTO content_publications (
  object_id, destination, published_version_id, status, published_by
)
SELECT
  'a7700000-0000-4000-8000-000000000002', 'public_web',
  'a7700000-0000-4000-8000-0000000002a1', 'live',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user')
ON CONFLICT (object_id, destination) DO UPDATE
  SET published_version_id = EXCLUDED.published_version_id, status = 'live';
