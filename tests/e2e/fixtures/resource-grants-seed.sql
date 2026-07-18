-- Resource-grants admin E2E seed (Epic #1202 Phase 3, #1206)
--
-- The authenticated resource-grants spec exercises model, assistant, and skill
-- access editors. scripts/db/seed-local.sql provides models and the authenticated
-- E2E harness provides assistants, but a clean local database otherwise has no
-- agent skills. Seed one deterministic shared skill so the skill access dialog is
-- always testable. Idempotent and safe to re-run against the disposable local DB.

INSERT INTO psd_agent_skills (
  id,
  name,
  scope,
  owner_user_id,
  s3_key,
  version,
  summary,
  allowed_tools,
  scan_status,
  approved_by,
  approved_at
)
SELECT
  '12060000-0000-4000-8000-000000001206',
  'E2E Resource Access Skill',
  'shared',
  u.id,
  'e2e/skills/resource-access/SKILL.md',
  1,
  'Fixture used to verify the skill resource-grants editor.',
  '[]'::jsonb,
  'clean',
  u.id,
  NOW()
FROM users u
WHERE u.cognito_sub = 'e2e-test-user'
ON CONFLICT DO NOTHING;
