-- Atrium group-directory visibility E2E seed (Epic #1202 Phase 2, #1205)
--
-- Seeds a document shared directly to a synced Google group and the two users the
-- gated functional spec (tests/e2e/atrium-group-visibility.functional.spec.ts)
-- asserts against: a MEMBER of the group (reads 200) and a NON-member (404,
-- existence-masked). Also seeds a DEACTIVATED group (is_active = false) the member
-- belongs to, plus a doc granted only to it, so the spec can prove deactivation
-- revokes access (the `groups.is_active = true` join filter in
-- listUserGroupEmailsByUserId). Idempotent (ON CONFLICT upserts), safe to re-run.
-- Apply to the local dev DB:
--
--   docker exec -i aistudio-postgres psql -U postgres -d aistudio \
--     < tests/e2e/fixtures/atrium-group-visibility-seed.sql
--
-- It does NOT write S3 source.md — the reader falls back to an empty article when
-- the blob is absent, which does not affect the visibility (200 vs 404) assertion.

-- 1. The two users. Neither is an admin (admins bypass the audience check). The
--    group MEMBER and the NON-member differ ONLY in their group membership below —
--    same role, no building/department/grade grant on the doc — so the ONLY thing
--    that admits the member is the `group` grant (#1205).
INSERT INTO users (email, first_name, last_name, cognito_sub)
VALUES ('group-member@example.com', 'Group', 'Member', 'e2e-group-member')
ON CONFLICT (cognito_sub) DO UPDATE SET email = EXCLUDED.email;

INSERT INTO users (email, first_name, last_name, cognito_sub)
VALUES ('group-outsider@example.com', 'Group', 'Outsider', 'e2e-group-outsider')
ON CONFLICT (cognito_sub) DO UPDATE SET email = EXCLUDED.email;

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u, roles r
WHERE u.cognito_sub IN ('e2e-group-member', 'e2e-group-outsider') AND r.name = 'staff'
ON CONFLICT DO NOTHING;

-- 2. The synced group (active). group_email is the stable, lowercased identifier;
--    uniqueness is on lower(group_email), so ON CONFLICT targets that expression.
INSERT INTO groups (id, group_email, name, source, is_active)
VALUES (
  'b1050000-0000-4000-a000-000000001205',
  'hs-staff-group@example.com', 'HS Staff Group', 'manual', true
)
ON CONFLICT (lower(group_email)) DO UPDATE
  SET is_active = true, name = EXCLUDED.name;

-- 3. Membership: ONLY the member is in the group (member_email lowercased, keyed by
--    email — resolves to users lazily by lower(email)). Resolve the group id via the
--    email so this works whether the group row above was newly inserted (our id) or
--    an existing one (its own id).
INSERT INTO group_members (group_id, member_email)
SELECT g.id, 'group-member@example.com'
FROM groups g
WHERE lower(g.group_email) = 'hs-staff-group@example.com'
ON CONFLICT (group_id, lower(member_email)) DO NOTHING;

-- 4. The content object: agent-created, GROUP visibility, owned by e2e-test-user
--    (so the member sees it ONLY via the group grant — not as owner/admin).
INSERT INTO content_objects (
  id, kind, title, slug, owner_user_id, created_by_actor, created_by_agent_id,
  visibility_level, status
)
SELECT
  'a7100000-0000-4000-8000-000000005205', 'document', 'Group Directory Playbook',
  'group-directory-playbook',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'agent',
  (SELECT id FROM agent_identities WHERE name = 'ship-reporter' LIMIT 1),
  'group', 'published'
ON CONFLICT (slug) DO UPDATE
  SET visibility_level = EXCLUDED.visibility_level, status = EXCLUDED.status;

-- 5. A single human version so the reader has a working head.
INSERT INTO content_versions (
  id, object_id, version_number, author_actor, author_user_id, body_format,
  body_location, summary
)
SELECT
  'a7100000-0000-4000-8000-0000000052a1', 'a7100000-0000-4000-8000-000000005205',
  1, 'human', (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'markdown', 'proof', 'Group-shared playbook'
ON CONFLICT (object_id, version_number) DO NOTHING;

UPDATE content_objects
  SET current_version_id = 'a7100000-0000-4000-8000-0000000052a1'
  WHERE id = 'a7100000-0000-4000-8000-000000005205';

-- 6. The GROUP grant: grant_value is the group email (lowercased), matched against
--    the viewer's synced memberships by canView / buildVisibilitySql.
INSERT INTO content_visibility_grants (object_id, grant_kind, grant_value)
VALUES (
  'a7100000-0000-4000-8000-000000005205', 'group', 'hs-staff-group@example.com'
)
ON CONFLICT (object_id, grant_kind, grant_value) DO NOTHING;

-- 7. Publish v1 live on the intranet so /c/[slug] renders for a permitted viewer.
INSERT INTO content_publications (
  object_id, destination, published_version_id, status, published_by
)
SELECT
  'a7100000-0000-4000-8000-000000005205', 'intranet',
  'a7100000-0000-4000-8000-0000000052a1', 'live',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user')
ON CONFLICT (object_id, destination) DO UPDATE
  SET published_version_id = EXCLUDED.published_version_id, status = 'live';

-- 8. DEACTIVATED-group revocation case (#1205 review): the MEMBER also belongs to
--    a group that has been deactivated (de-selected / dropped from the directory —
--    the sync flips is_active to false but keeps the row and its memberships).
--    A doc granted ONLY to that group must 404 for them: the
--    `groups.is_active = true` filter in listUserGroupEmailsByUserId is the sole
--    mechanism that revokes the grant, and this is its end-to-end proof.
INSERT INTO groups (id, group_email, name, source, is_active)
VALUES (
  'b1050000-0000-4000-a000-000000001215',
  'retired-group@example.com', 'Retired Group', 'manual', false
)
ON CONFLICT (lower(group_email)) DO UPDATE
  SET is_active = false, name = EXCLUDED.name;

INSERT INTO group_members (group_id, member_email)
SELECT g.id, 'group-member@example.com'
FROM groups g
WHERE lower(g.group_email) = 'retired-group@example.com'
ON CONFLICT (group_id, lower(member_email)) DO NOTHING;

INSERT INTO content_objects (
  id, kind, title, slug, owner_user_id, created_by_actor, created_by_agent_id,
  visibility_level, status
)
SELECT
  'a7100000-0000-4000-8000-000000005215', 'document', 'Retired Group Playbook',
  'retired-group-playbook',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'agent',
  (SELECT id FROM agent_identities WHERE name = 'ship-reporter' LIMIT 1),
  'group', 'published'
ON CONFLICT (slug) DO UPDATE
  SET visibility_level = EXCLUDED.visibility_level, status = EXCLUDED.status;

INSERT INTO content_versions (
  id, object_id, version_number, author_actor, author_user_id, body_format,
  body_location, summary
)
SELECT
  'a7100000-0000-4000-8000-0000000052b1', 'a7100000-0000-4000-8000-000000005215',
  1, 'human', (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user'),
  'markdown', 'proof', 'Playbook shared only to a deactivated group'
ON CONFLICT (object_id, version_number) DO NOTHING;

UPDATE content_objects
  SET current_version_id = 'a7100000-0000-4000-8000-0000000052b1'
  WHERE id = 'a7100000-0000-4000-8000-000000005215';

INSERT INTO content_visibility_grants (object_id, grant_kind, grant_value)
VALUES (
  'a7100000-0000-4000-8000-000000005215', 'group', 'retired-group@example.com'
)
ON CONFLICT (object_id, grant_kind, grant_value) DO NOTHING;

INSERT INTO content_publications (
  object_id, destination, published_version_id, status, published_by
)
SELECT
  'a7100000-0000-4000-8000-000000005215', 'intranet',
  'a7100000-0000-4000-8000-0000000052b1', 'live',
  (SELECT id FROM users WHERE cognito_sub = 'e2e-test-user')
ON CONFLICT (object_id, destination) DO UPDATE
  SET published_version_id = EXCLUDED.published_version_id, status = 'live';
