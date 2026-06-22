-- Migration 081: Skill platform — allowed-tools persistence + catalog discoverability
-- Part of #925 (Epic #922 — connect Epic #910 agent_skills to the SKILL.md pipeline)
--
-- Two additive changes:
--   1. psd_agent_skills.allowed_tools — the skill's `allowed-tools` frontmatter,
--      persisted on publish so it can be (a) registered into tool_catalog when the
--      skill is approved (#925 AC#5) and (b) enforced at invocation time, where the
--      session's tool set is intersected with this list (#925 AC#6). Previously the
--      derived allowed-tools lived only in the SKILL.md frontmatter + the audit row,
--      neither of which is queryable on the hot path.
--   2. A top-level "Skills" navigation item pointing at the user-facing skill catalog
--      (#925 AC#4). Visible to every authenticated user (requires_role = NULL).
--
-- ADDITIVE and idempotent. No PL/pgSQL triggers / DO $$ blocks (the RDS Data API
-- migration runner's statement splitter cannot handle dollar-quoted blocks — see
-- migration 079). allowed_tools is maintained by application code via Drizzle.

-- Mark any previous failed attempts as completed so the runner stops retrying.
UPDATE migration_log SET status = 'completed'
WHERE description = '081-skill-platform-catalog.sql' AND status = 'failed';

-- 1. allowed_tools column (defaults to an empty list = "no pin; open to all
--    catalog tools the caller already holds", matching the serializer contract).
ALTER TABLE psd_agent_skills
    ADD COLUMN IF NOT EXISTS allowed_tools JSONB DEFAULT '[]'::jsonb NOT NULL;

-- 2. User-facing skill catalog navigation entry (top-level, all authenticated users).
INSERT INTO navigation_items (label, icon, link, parent_id, requires_role, position, is_active, type, description)
SELECT 'Skills', 'IconBriefcase', '/skills', NULL, NULL, 35, true, 'link',
       'Browse approved skills and use them in a Nexus chat'
WHERE NOT EXISTS (
    SELECT 1 FROM navigation_items WHERE link = '/skills'
);
