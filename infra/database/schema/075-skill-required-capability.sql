-- Migration 075: Skill-load capability gate + image-gen skill capability
--
-- Adds the schema plumbing for per-skill capability gating. The column
-- psd_agent_skills.required_capability stores the capability identifier
-- that a user must hold (via their role grants in tools/role_tools) to
-- invoke the skill. NULL means the skill is open to all (preserves prior
-- behavior for migrations 070-era skills).
--
-- The harness-level enforcement (reading this column and filtering
-- skill exposure per session) is a planned follow-up once OpenClaw
-- exposes a per-session catalog hook. Currently, skills enforce their
-- own capability gate at invocation time (see psd-image-gen/generate.js
-- enforceCapability()).
--
-- Seeds the first restricted capability (`skill.image-gen`) used by the
-- new psd-image-gen skill, and grants it to administrator + staff roles
-- so they can use it before the admin UI from issue #923 ships. Adjust
-- via direct DB or the upcoming UI thereafter.
--
-- The `tools` table is the legacy capabilities registry (renamed to
-- `capabilities` under epic #922 / issue #923; the rename is mechanical
-- for our string identifier `skill.image-gen`).

UPDATE migration_log SET status = 'completed'
WHERE description = '075-skill-required-capability.sql' AND status = 'failed';

-- Add the gate column. NULL means the skill is unrestricted.
ALTER TABLE psd_agent_skills
    ADD COLUMN IF NOT EXISTS required_capability TEXT NULL;

-- Index for the harness's per-invocation capability join.
CREATE INDEX IF NOT EXISTS idx_agent_skills_required_capability
    ON psd_agent_skills (required_capability)
    WHERE required_capability IS NOT NULL;

-- Register the image-gen capability. is_active stays true so role
-- checks succeed; description documents what gating it implies.
INSERT INTO tools (identifier, name, description, is_active)
VALUES (
    'skill.image-gen',
    'Agent skill: image generation',
    'Allows agent skills to invoke psd-image-gen (OpenAI gpt-image-2). Shared API key — usage costs accrue to the district.',
    true
)
ON CONFLICT (identifier) DO NOTHING;

-- Grant the capability to administrator and staff roles. Other roles
-- (student, etc.) do not receive it by default.
INSERT INTO role_tools (role_id, tool_id)
SELECT r.id, t.id
FROM roles r
CROSS JOIN tools t
WHERE r.name IN ('administrator', 'staff')
  AND t.identifier = 'skill.image-gen'
ON CONFLICT (role_id, tool_id) DO NOTHING;
