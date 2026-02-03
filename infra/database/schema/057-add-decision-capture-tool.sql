-- 057-add-decision-capture-tool.sql: Add Decision Capture tool, role grant, navigation, and model setting
-- Migration file - only runs on existing databases (not fresh installs)
-- Epic #675 (Context Graph Decision Capture Layer) - Issue #721
--
-- These records were only present in seed-local.sql, causing the tool to
-- redirect to /dashboard on dev/prod due to hasToolAccess() returning false.

-- 1. Insert the Decision Capture tool
INSERT INTO tools (identifier, name, description, is_active, created_at, updated_at)
SELECT
    'decision-capture',
    'Decision Capture',
    'Extract and capture decisions from meeting transcripts into the context graph',
    true,
    NOW(),
    NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM tools WHERE identifier = 'decision-capture'
);

-- 2. Grant access to the Decision Capture tool for administrators
INSERT INTO role_tools (role_id, tool_id, created_at)
SELECT r.id, t.id, NOW()
FROM roles r, tools t
WHERE r.name = 'administrator'
  AND t.identifier = 'decision-capture'
  AND NOT EXISTS (
    SELECT 1 FROM role_tools rt
    WHERE rt.role_id = r.id AND rt.tool_id = t.id
  );

-- 3. Add navigation item for Decision Capture under Utilities section
INSERT INTO navigation_items (
    label,
    icon,
    link,
    parent_id,
    tool_id,
    requires_role,
    position,
    is_active,
    created_at,
    description,
    type
)
SELECT
    'Decision Capture',
    'IconGitBranch',
    '/nexus/decision-capture',
    (SELECT id FROM navigation_items WHERE label = 'Utilities' AND type = 'section' LIMIT 1),
    t.id,
    NULL,
    40,
    true,
    NOW(),
    'Extract decisions from meeting transcripts',
    'link'
FROM tools t
WHERE t.identifier = 'decision-capture'
  AND NOT EXISTS (
    SELECT 1 FROM navigation_items ni
    WHERE ni.link = '/nexus/decision-capture'
  );

-- 4. Add DECISION_CAPTURE_MODEL setting (required by decision-chat route)
-- Uses gemini-3-flash-preview which matches the model_id in ai_models on dev/prod.
-- Falls back gracefully: if this model_id doesn't exist in ai_models, the route
-- returns a clear error message asking an administrator to update the setting.
INSERT INTO settings (key, value, description, category, is_secret)
VALUES (
    'DECISION_CAPTURE_MODEL',
    'gemini-3-flash-preview',
    'AI model used for decision capture from meeting transcripts. Must match a model_id in ai_models table.',
    'ai',
    false
)
ON CONFLICT (key) DO NOTHING;
