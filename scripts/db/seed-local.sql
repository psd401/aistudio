-- Local Development Seed Data
-- Issue #607 - Local Development Environment
--
-- This file contains additional seed data useful for local development
-- that goes beyond the basic 005-initial-data.sql.
--
-- Run manually with: bun run db:seed
-- Or via psql: psql -U postgres -d aistudio -f scripts/db/seed-local.sql
--
-- Note: This file is idempotent - safe to run multiple times.

-- ============================================================================
-- Local Test User
-- ============================================================================
-- Create a local test user for development (bypasses Cognito auth locally)
-- Email: test@example.com
-- This user is pre-assigned the administrator role for full access
--
-- cognito_sub = 'e2e-test-user' is REQUIRED for the Playwright auth harness:
-- mintSessionToken() (tests/e2e/helpers/session-auth.ts) mints a session with
-- sub='e2e-test-user', and hasCapabilityAccess() joins directly on
-- users.cognito_sub. Without this value the test user's cognito_sub is NULL, the
-- capability join returns zero rows, and every capability-gated route redirects —
-- making the functional E2E specs fail on a freshly seeded DB. cognito_sub is the
-- table's unique key (email is NOT unique), so it is also the correct conflict
-- target for idempotency.
INSERT INTO users (email, first_name, last_name, cognito_sub, last_sign_in_at)
VALUES (
    'test@example.com',
    'Test',
    'User',
    'e2e-test-user',
    CURRENT_TIMESTAMP
)
ON CONFLICT (cognito_sub) DO UPDATE SET
    email = EXCLUDED.email,
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name,
    last_sign_in_at = EXCLUDED.last_sign_in_at;

-- Assign administrator role to test user
INSERT INTO user_roles (user_id, role_id)
SELECT
    u.id,
    r.id
FROM users u
CROSS JOIN roles r
WHERE u.email = 'test@example.com'
  AND r.name = 'administrator'
ON CONFLICT (user_id, role_id) DO NOTHING;

-- ============================================================================
-- Additional Test Users (optional)
-- ============================================================================

-- Staff user for testing staff-level access.
-- cognito_sub is the unique key (email is not), so set a deterministic value to
-- make this seed idempotent — ON CONFLICT DO NOTHING with no target would
-- otherwise insert a duplicate row on every re-run.
INSERT INTO users (email, first_name, last_name, cognito_sub)
VALUES (
    'staff@example.com',
    'Staff',
    'Member',
    'e2e-staff-user'
)
ON CONFLICT (cognito_sub) DO UPDATE SET
    email = EXCLUDED.email,
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name;

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u CROSS JOIN roles r
WHERE u.email = 'staff@example.com' AND r.name = 'staff'
ON CONFLICT (user_id, role_id) DO NOTHING;

-- Student user for testing student-level access.
-- cognito_sub is the unique key (email is not); deterministic value keeps the
-- seed idempotent (see staff user note above).
INSERT INTO users (email, first_name, last_name, cognito_sub)
VALUES (
    'student@example.com',
    'Student',
    'Test',
    'e2e-student-user'
)
ON CONFLICT (cognito_sub) DO UPDATE SET
    email = EXCLUDED.email,
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name;

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u CROSS JOIN roles r
WHERE u.email = 'student@example.com' AND r.name = 'student'
ON CONFLICT (user_id, role_id) DO NOTHING;

-- ============================================================================
-- Capabilities (role-gated UI features; successor to the legacy tools table)
-- ============================================================================
-- hasCapabilityAccess() reads from capabilities/role_capabilities. Seed ALL 7
-- identifiers from CAPABILITY_MANIFEST (lib/capabilities/manifest.ts) so local
-- test users keep access immediately on a freshly seeded DB — before the
-- boot-time manifest sync has run:
-- - assistant-architect: schedules, execute API
-- - model-compare: compare feature
-- - knowledge-repositories: repositories, prompt library
-- - decision-capture, voice-mode: Nexus features
-- - internal-performance-monitoring, internal-system-administration: internal
--   monitoring/admin APIs (would 403 for admin until first server boot otherwise)
-- These are marked source='manual' here; the boot-time manifest sync flips
-- manifest-managed identifiers to source='code' when the dev server starts.

INSERT INTO capabilities (identifier, name, description, is_active, source) VALUES
('assistant-architect', 'Assistant Architect', 'Build and schedule custom AI assistants', true, 'manual'),
('model-compare', 'Model Compare', 'Compare AI model responses side-by-side', true, 'manual'),
('knowledge-repositories', 'Knowledge Repositories', 'Manage knowledge bases for AI assistants', true, 'manual'),
('decision-capture', 'Decision Capture', 'Extract and capture decisions from meeting transcripts into the context graph', true, 'manual'),
('voice-mode', 'Voice Mode', 'Real-time voice conversations in Nexus using AI speech providers', true, 'manual'),
('internal-performance-monitoring', 'Internal Performance Monitoring', 'Access internal performance monitoring dashboards and metrics.', true, 'manual'),
('internal-system-administration', 'Internal System Administration', 'Access internal system administration tooling and diagnostics.', true, 'manual')
ON CONFLICT (identifier) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    is_active = EXCLUDED.is_active,
    updated_at = CURRENT_TIMESTAMP;

-- Grant these capabilities to administrator role
INSERT INTO role_capabilities (role_id, capability_id)
SELECT r.id, c.id
FROM roles r
CROSS JOIN capabilities c
WHERE r.name = 'administrator'
  AND c.identifier IN ('assistant-architect', 'model-compare', 'knowledge-repositories', 'decision-capture', 'voice-mode', 'internal-performance-monitoring', 'internal-system-administration')
ON CONFLICT (role_id, capability_id) DO NOTHING;

-- Grant assistant-architect and model-compare to staff role
INSERT INTO role_capabilities (role_id, capability_id)
SELECT r.id, c.id
FROM roles r
CROSS JOIN capabilities c
WHERE r.name = 'staff'
  AND c.identifier IN ('assistant-architect', 'model-compare')
ON CONFLICT (role_id, capability_id) DO NOTHING;

-- ============================================================================
-- Navigation Items
-- ============================================================================
-- Standard navigation structure for the application

-- Clear existing navigation and reset
DELETE FROM navigation_item_roles;
DELETE FROM navigation_items;
ALTER SEQUENCE navigation_items_id_seq RESTART WITH 1;

-- Main sections
INSERT INTO navigation_items (id, label, icon, link, parent_id, capability_id, requires_role, position, is_active, description, type) VALUES
(20, 'Dashboard', 'IconHome', '/dashboard', NULL, NULL, NULL, 0, true, '', 'link'),
(39, 'Nexus', 'IconRobot', '/nexus', NULL, NULL, NULL, 10, true, '', 'link'),
(21, 'Instructional', 'IconChalkboard', '', NULL, NULL, NULL, 20, true, '', 'section'),
(10, 'Operational', 'IconBuildingBank', NULL, NULL, NULL, NULL, 30, true, NULL, 'section'),
(9, 'Administrative', 'IconBriefcase', NULL, NULL, NULL, NULL, 40, true, NULL, 'section'),
(8, 'Experiments', 'IconFlask', NULL, NULL, NULL, NULL, 50, true, NULL, 'section'),
(19, 'Utilities', 'IconTools', NULL, NULL, NULL, NULL, 60, true, NULL, 'section'),
(12, 'Ideas', 'IconBulb', '/ideas', NULL, NULL, NULL, 70, true, NULL, 'link'),
(11, 'Admin', 'IconShield', '', NULL, NULL, 'administrator', 80, true, '', 'section');

-- Admin sub-items (alphabetical order)
INSERT INTO navigation_items (id, label, icon, link, parent_id, capability_id, requires_role, position, is_active, description, type) VALUES
(46, 'Activity Dashboard', 'IconActivity', '/admin/activity', 11, NULL, 'administrator', 0, true, 'View activity across Nexus, Assistant Architect, and Model Compare', 'link'),
(16, 'AI Models', 'IconRobot', '/admin/models', 11, NULL, 'administrator', 10, true, '', 'link'),
(18, 'Assistant Administration', 'IconBraces', '/admin/assistants', 11, NULL, 'administrator', 20, true, '', 'link'),
(48, 'Context Graph', 'IconGitBranch', '/admin/graph', 11, NULL, 'administrator', 30, true, 'Manage context graph nodes and edges', 'link'),
(14, 'Navigation Manager', 'IconHome', '/admin/navigation', 11, NULL, 'administrator', 40, true, '', 'link'),
(49, 'OAuth Clients', 'IconKey', '/admin/oauth-clients', 11, NULL, 'administrator', 50, true, 'Manage OAuth client applications', 'link'),
(45, 'Prompt Management', 'IconBriefcase', '/admin/prompts', 11, NULL, 'administrator', 60, true, '', 'link'),
(38, 'Repository Manager', 'IconBuildingBank', '/admin/repositories', 11, NULL, 'administrator', 70, true, '', 'link'),
(17, 'Role Management', 'IconUsersGroup', '/admin/roles', 11, NULL, 'administrator', 80, true, '', 'link'),
(13, 'System Settings', 'IconTools', '/admin/settings', 11, NULL, 'administrator', 90, true, '', 'link'),
(15, 'User Management', 'IconUser', '/admin/users', 11, NULL, 'administrator', 100, true, '', 'link');

-- Utilities sub-items.
-- capability_id gates each item by the capability the route enforces. A NULL
-- capability_id reads as "not gated" in the navigation API (see app/api/
-- navigation/route.ts: `if (!item.capabilityId) continue`), which in local dev
-- would expose these items to low-privilege roles — the inverse of production
-- and a vacuous pass for any "user CANNOT see gated nav" E2E assertion. Resolve
-- each capability by identifier (decoupled from id sequencing); the capabilities
-- above are seeded before this INSERT so every subquery returns a row.
INSERT INTO navigation_items (id, label, icon, link, parent_id, capability_id, requires_role, position, is_active, description, type) VALUES
(40, 'Assistant Scheduler', 'IconCalendar', '/schedules', 19, (SELECT id FROM capabilities WHERE identifier = 'assistant-architect'), NULL, 0, true, '', 'link'),
(7, 'Assistant Architect', 'IconBraces', '/utilities/assistant-architect', 19, (SELECT id FROM capabilities WHERE identifier = 'assistant-architect'), NULL, 10, true, NULL, 'link'),
(37, 'Model Compare', 'IconRobot', '/compare', 19, (SELECT id FROM capabilities WHERE identifier = 'model-compare'), NULL, 20, true, 'Compare AI model responses side-by-side', 'link'),
(36, 'Repositories', 'IconBuildingBank', '/repositories', 19, (SELECT id FROM capabilities WHERE identifier = 'knowledge-repositories'), NULL, 30, true, '', 'link'),
(47, 'Decision Capture', 'IconGitBranch', '/nexus/decision-capture', 19, (SELECT id FROM capabilities WHERE identifier = 'decision-capture'), NULL, 40, true, 'Extract decisions from meeting transcripts', 'link');

-- Update sequence to max id + 1
SELECT setval('navigation_items_id_seq', (SELECT MAX(id) FROM navigation_items));

-- ============================================================================
-- AI Models
-- ============================================================================
-- Current frontier models for local development
-- Replaces outdated models from 005-initial-data.sql

-- Clear existing models and reset
DELETE FROM ai_models;
ALTER SEQUENCE ai_models_id_seq RESTART WITH 1;

-- Insert current models
INSERT INTO ai_models (
    name, model_id, provider, description, capabilities, max_tokens, active,
    nexus_enabled, architect_enabled, allowed_roles,
    input_cost_per_1k_tokens, output_cost_per_1k_tokens, cached_input_cost_per_1k_tokens
) VALUES
-- Google Gemini 3 Models
(
    'Gemini 3 Pro',
    'gemini-3-pro',
    'google',
    'Google''s most capable reasoning model with 1M token context, ideal for complex research projects and multi-step problem solving',
    '["chat", "function_calling", "json_mode", "image_analysis", "streaming", "reasoning", "thinking"]',
    1000000,
    true,
    true,
    true,
    NULL,
    0.002000,
    0.012000,
    0.000500
),
(
    'Gemini 3 Flash',
    'gemini-3-flash',
    'google',
    'Fast and cost-effective model that outperforms previous generations, great for quick questions and everyday assignments',
    '["chat", "function_calling", "json_mode", "image_analysis", "streaming", "reasoning"]',
    1000000,
    true,
    true,
    true,
    NULL,
    0.000500,
    0.003000,
    0.000125
),
(
    'Gemini 3 Pro Image (Nano Banana Pro)',
    'gemini-3-pro-image-preview',
    'google',
    'State-of-the-art image generation model with advanced text rendering, perfect for creating diagrams, infographics, and visual learning materials',
    '["chat", "image_generation", "image_analysis", "streaming"]',
    200000,
    true,
    true,
    false,
    NULL,
    0.002000,
    0.120000,
    NULL
),
(
    'Gemini 3.1 Pro',
    'gemini-3.1-pro-preview',
    'google',
    'Google''s most advanced reasoning model with a massive context window, ideal for complex research projects, detailed essay feedback, and multi-step problem solving',
    '["chat", "function_calling", "json_mode", "image_analysis", "streaming", "thinking", "code_execution", "web_search"]',
    1048576,
    true,
    true,
    true,
    NULL,
    0.002000,
    0.012000,
    0.000200
),
(
    'Nano Banana 2',
    'gemini-3.1-flash-image-preview',
    'google',
    'Fast and affordable image generation model that creates high-quality images up to 4K resolution, perfect for art projects, presentations, and visual learning activities',
    '["chat", "image_generation", "image_analysis", "streaming"]',
    1048576,
    true,
    true,
    false,
    NULL,
    0.000250,
    0.001500,
    NULL
),

-- OpenAI GPT-5.2 Models
(
    'GPT-5.2',
    'gpt-5.2',
    'openai',
    'OpenAI''s flagship model with 400K context window, excellent for complex coding projects and detailed essay feedback',
    '["chat", "function_calling", "json_mode", "image_analysis", "streaming", "reasoning", "web_search", "code_interpreter"]',
    400000,
    true,
    true,
    true,
    NULL,
    0.001750,
    0.014000,
    0.000175
),
(
    'GPT-5.2 Pro',
    'gpt-5.2-pro',
    'openai',
    'OpenAI''s most intelligent model with extended reasoning for high-stakes research and complex problem solving',
    '["chat", "function_calling", "json_mode", "image_analysis", "streaming", "reasoning", "thinking", "web_search", "code_interpreter"]',
    400000,
    true,
    true,
    true,
    '["administrator", "staff"]',
    0.001750,
    0.014000,
    0.000175
),
(
    'GPT Image 1.5',
    'gpt-image-1.5',
    'openai',
    'OpenAI''s latest image generation model with improved quality and 20% lower costs, ideal for creating visuals for presentations and projects',
    '["image_generation"]',
    4096,
    true,
    true,
    false,
    NULL,
    0.010000,
    0.040000,
    NULL
),

-- Anthropic Claude Models (via AWS Bedrock US Inference)
(
    'Claude Opus 4.5 (Bedrock)',
    'us.anthropic.claude-opus-4-5-20250929-v1:0',
    'amazon-bedrock',
    'Anthropic''s most capable model with exceptional reasoning and coding skills, perfect for complex research and detailed analysis',
    '["chat", "function_calling", "json_mode", "image_analysis", "streaming", "thinking", "computer_use"]',
    200000,
    true,
    true,
    true,
    '["administrator", "staff"]',
    0.005000,
    0.025000,
    0.000500
),
(
    'Claude Sonnet 4.5 (Bedrock)',
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'amazon-bedrock',
    'Anthropic''s best balance of intelligence and speed, excellent for coding assistance and creative writing projects',
    '["chat", "function_calling", "json_mode", "image_analysis", "streaming", "thinking", "computer_use"]',
    200000,
    true,
    true,
    true,
    NULL,
    0.003000,
    0.015000,
    0.000300
);

-- Update sequence to max id + 1
SELECT setval('ai_models_id_seq', (SELECT MAX(id) FROM ai_models));

-- ============================================================================
-- Settings (AI Configuration)
-- ============================================================================
-- Decision framework LLM prompt - required by getDecisionFrameworkPrompt()
-- Part of Epic #675 (Context Graph Decision Capture Layer) - Issue #680

INSERT INTO settings (key, value, description, category, is_secret)
VALUES (
    'DECISION_FRAMEWORK_PROMPT',
    'You are helping capture decisions in a structured context graph. Every decision should be recorded with enough context to understand it later.

## Node Types
Use these node types when creating graph nodes for decisions:
- **decision** — The actual decision that was made
- **evidence** — Data, research, or observations that informed the decision
- **constraint** — A limiting factor (budget, timeline, staffing, policy compliance, etc.)
- **reasoning** — Intermediate logic, analysis, or calculations
- **person** — An individual who proposed, made, or approved the decision
- **condition** — A future trigger that would cause this decision to be revisited
- **request** — The original ask or problem statement
- **policy** — A district or board policy that was referenced
- **outcome** — The result or consequence of the decision

## Edge Types
Use these edge types to connect nodes:
- **INFORMED** — Evidence/data informed a decision
- **LED_TO** — A request or reasoning led to a decision
- **CONSTRAINED** — A constraint limited options
- **PROPOSED** — A person proposed a decision
- **APPROVED_BY** — A decision was approved by a person
- **SUPPORTED_BY** — A decision is backed by evidence
- **REPLACED_BY** — A decision superseded another
- **CHANGED_BY** — A decision was modified by an event
- **PART_OF** — Reasoning is part of a decision process
- **RESULTED_IN** — A decision produced an outcome
- **PRECEDENT** — One decision set precedent for another
- **CONTEXT** — Something provides context for a decision
- **COMPARED_AGAINST** — Evidence was compared with other evidence
- **INFLUENCED** — One decision influenced another
- **BLOCKED** — A constraint blocked an option
- **WOULD_REQUIRE** — Implementing a decision would require something
- **CONDITION** — A condition applies to a decision
- **REJECTED** — A person rejected an alternative

## Completeness
A decision is considered complete when it has ALL of the following:
1. At least one **decision** node (what was decided)
2. At least one **person** connected via PROPOSED or APPROVED_BY (who made it)
3. At least one **evidence** or **constraint** connected via INFORMED or CONSTRAINED (what informed it)
4. At least one **condition** connected via CONDITION (what would cause revisiting it)

When capturing a decision, proactively ask about any missing elements. For example:
- "Who proposed or approved this?"
- "What data or constraints informed this choice?"
- "Under what conditions should this decision be revisited?"',
    'LLM system prompt fragment for decision capture in the context graph. Describes node types, edge types, and completeness criteria.',
    'ai',
    false
)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Branding Settings
-- ============================================================================
-- Configurable branding for white-label deployments (Issue #824)
-- These defaults match the original PSD branding. Other organizations
-- should update these values in the admin settings UI.

-- Defaults are intentionally generic for white-label deployments.
-- Update these in the admin settings UI for your organization.
INSERT INTO settings (key, value, description, category, is_secret)
VALUES
    ('BRANDING_ORG_NAME', 'Your Organization', 'Organization name displayed across the application', 'branding', false),
    ('BRANDING_APP_NAME', 'AI Studio', 'Application name displayed in titles and headers', 'branding', false),
    ('BRANDING_PRIMARY_COLOR', '#1B365D', 'Primary brand color as hex value', 'branding', false),
    ('BRANDING_LOGO_URL', '/logo.png', 'Logo image URL (local path like /logo.png or S3 key)', 'branding', false),
    ('BRANDING_SUPPORT_URL', 'https://example.com', 'Organization website or support URL', 'branding', false)
ON CONFLICT (key) DO NOTHING;

-- Decision capture model setting - required by decision-chat route
-- Part of Epic #675 (Context Graph Decision Capture Layer) - Issue #681
INSERT INTO settings (key, value, description, category, is_secret)
VALUES (
    'DECISION_CAPTURE_MODEL',
    'gemini-3-flash',
    'AI model used for decision capture from meeting transcripts. Must match a model_id in ai_models table.',
    'ai',
    false
)
ON CONFLICT (key) DO NOTHING;

-- Voice mode global kill switch - Issue #876
-- Use DO UPDATE so this overrides the migration default of 'false' for local dev
INSERT INTO settings (key, value, description, category, is_secret)
VALUES (
    'VOICE_ENABLED',
    'true',
    'Global kill switch for voice mode. Set to "true" to enable voice features.',
    'voice',
    false
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ============================================================================
-- Summary
-- ============================================================================

DO $$
DECLARE
    user_count INT;
    role_count INT;
    model_count INT;
    capability_count INT;
    nav_count INT;
    settings_count INT;
BEGIN
    SELECT COUNT(*) INTO user_count FROM users;
    SELECT COUNT(*) INTO role_count FROM roles;
    SELECT COUNT(*) INTO model_count FROM ai_models WHERE active = true;
    SELECT COUNT(*) INTO capability_count FROM capabilities WHERE is_active = true;
    SELECT COUNT(*) INTO nav_count FROM navigation_items WHERE is_active = true;
    SELECT COUNT(*) INTO settings_count FROM settings;

    RAISE NOTICE '';
    RAISE NOTICE '==========================================';
    RAISE NOTICE 'Local Seed Data Applied Successfully';
    RAISE NOTICE '==========================================';
    RAISE NOTICE 'Users: %', user_count;
    RAISE NOTICE 'Roles: %', role_count;
    RAISE NOTICE 'Active AI Models: %', model_count;
    RAISE NOTICE 'Active Capabilities: %', capability_count;
    RAISE NOTICE 'Navigation Items: %', nav_count;
    RAISE NOTICE 'Settings: %', settings_count;
    RAISE NOTICE '';
    RAISE NOTICE 'Test accounts created:';
    RAISE NOTICE '  - test@example.com (administrator)';
    RAISE NOTICE '  - staff@example.com (staff)';
    RAISE NOTICE '  - student@example.com (student)';
    RAISE NOTICE '';
    RAISE NOTICE 'AI Models seeded:';
    RAISE NOTICE '  - Gemini 3 Pro, Gemini 3 Flash, Gemini 3 Pro Image';
    RAISE NOTICE '  - Gemini 3.1 Pro, Nano Banana 2';
    RAISE NOTICE '  - GPT-5.2, GPT-5.2 Pro, GPT Image 1.5';
    RAISE NOTICE '  - Claude Opus 4.5, Claude Sonnet 4.5 (Bedrock)';
    RAISE NOTICE '==========================================';
END $$;
