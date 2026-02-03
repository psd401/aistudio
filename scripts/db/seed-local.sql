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

INSERT INTO users (email, first_name, last_name, last_sign_in_at)
VALUES (
    'test@example.com',
    'Test',
    'User',
    CURRENT_TIMESTAMP
)
ON CONFLICT DO NOTHING;

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

-- Staff user for testing staff-level access
INSERT INTO users (email, first_name, last_name)
VALUES (
    'staff@example.com',
    'Staff',
    'Member'
)
ON CONFLICT DO NOTHING;

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u CROSS JOIN roles r
WHERE u.email = 'staff@example.com' AND r.name = 'staff'
ON CONFLICT (user_id, role_id) DO NOTHING;

-- Student user for testing student-level access
INSERT INTO users (email, first_name, last_name)
VALUES (
    'student@example.com',
    'Student',
    'Test'
)
ON CONFLICT DO NOTHING;

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u CROSS JOIN roles r
WHERE u.email = 'student@example.com' AND r.name = 'student'
ON CONFLICT (user_id, role_id) DO NOTHING;

-- ============================================================================
-- Tools (ensuring all code-referenced tools exist)
-- ============================================================================
-- The codebase uses hasToolAccess() with these identifiers:
-- - assistant-architect: schedules, execute API
-- - model-compare: compare feature
-- - knowledge-repositories: repositories, prompt library

INSERT INTO tools (identifier, name, description, is_active) VALUES
('assistant-architect', 'Assistant Architect', 'Build and schedule custom AI assistants', true),
('model-compare', 'Model Compare', 'Compare AI model responses side-by-side', true),
('knowledge-repositories', 'Knowledge Repositories', 'Manage knowledge bases for AI assistants', true),
('decision-capture', 'Decision Capture', 'Extract and capture decisions from meeting transcripts into the context graph', true)
ON CONFLICT (identifier) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    is_active = EXCLUDED.is_active,
    updated_at = CURRENT_TIMESTAMP;

-- Grant these tools to administrator role
INSERT INTO role_tools (role_id, tool_id)
SELECT r.id, t.id
FROM roles r
CROSS JOIN tools t
WHERE r.name = 'administrator'
  AND t.identifier IN ('assistant-architect', 'model-compare', 'knowledge-repositories', 'decision-capture')
ON CONFLICT (role_id, tool_id) DO NOTHING;

-- Grant assistant-architect and model-compare to staff role
INSERT INTO role_tools (role_id, tool_id)
SELECT r.id, t.id
FROM roles r
CROSS JOIN tools t
WHERE r.name = 'staff'
  AND t.identifier IN ('assistant-architect', 'model-compare')
ON CONFLICT (role_id, tool_id) DO NOTHING;

-- ============================================================================
-- Navigation Items
-- ============================================================================
-- Standard navigation structure for the application

-- Clear existing navigation and reset
DELETE FROM navigation_item_roles;
DELETE FROM navigation_items;
ALTER SEQUENCE navigation_items_id_seq RESTART WITH 1;

-- Main sections
INSERT INTO navigation_items (id, label, icon, link, parent_id, tool_id, requires_role, position, is_active, description, type) VALUES
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
INSERT INTO navigation_items (id, label, icon, link, parent_id, tool_id, requires_role, position, is_active, description, type) VALUES
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

-- Utilities sub-items
INSERT INTO navigation_items (id, label, icon, link, parent_id, tool_id, requires_role, position, is_active, description, type) VALUES
(40, 'Assistant Scheduler', 'IconCalendar', '/schedules', 19, NULL, NULL, 0, true, '', 'link'),
(7, 'Assistant Architect', 'IconBraces', '/utilities/assistant-architect', 19, NULL, NULL, 10, true, NULL, 'link'),
(37, 'Model Compare', 'IconRobot', '/compare', 19, NULL, NULL, 20, true, 'Compare AI model responses side-by-side', 'link'),
(36, 'Repositories', 'IconBuildingBank', '/repositories', 19, NULL, NULL, 30, true, '', 'link'),
(47, 'Decision Capture', 'IconGitBranch', '/nexus/decision-capture', 19, NULL, NULL, 40, true, 'Extract decisions from meeting transcripts', 'link');

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

-- ============================================================================
-- Summary
-- ============================================================================

DO $$
DECLARE
    user_count INT;
    role_count INT;
    model_count INT;
    tool_count INT;
    nav_count INT;
    settings_count INT;
BEGIN
    SELECT COUNT(*) INTO user_count FROM users;
    SELECT COUNT(*) INTO role_count FROM roles;
    SELECT COUNT(*) INTO model_count FROM ai_models WHERE active = true;
    SELECT COUNT(*) INTO tool_count FROM tools WHERE is_active = true;
    SELECT COUNT(*) INTO nav_count FROM navigation_items WHERE is_active = true;
    SELECT COUNT(*) INTO settings_count FROM settings;

    RAISE NOTICE '';
    RAISE NOTICE '==========================================';
    RAISE NOTICE 'Local Seed Data Applied Successfully';
    RAISE NOTICE '==========================================';
    RAISE NOTICE 'Users: %', user_count;
    RAISE NOTICE 'Roles: %', role_count;
    RAISE NOTICE 'Active AI Models: %', model_count;
    RAISE NOTICE 'Active Tools: %', tool_count;
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
    RAISE NOTICE '  - GPT-5.2, GPT-5.2 Pro, GPT Image 1.5';
    RAISE NOTICE '  - Claude Opus 4.5, Claude Sonnet 4.5 (Bedrock)';
    RAISE NOTICE '==========================================';
END $$;
