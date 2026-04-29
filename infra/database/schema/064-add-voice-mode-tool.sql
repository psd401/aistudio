-- 064-add-voice-mode-tool.sql: Add Voice Mode tool and VOICE_ENABLED setting
-- Runs on all databases via the Lambda migration runner.
-- Issue #876 — Voice Mode Permissions + Admin Configuration UI
--
-- Registers 'voice-mode' as a tool in the permission system so admins can
-- enable/disable voice per role via Admin > Role Management > Tool Assignments.
-- Default: NOT assigned to any role (opt-in rollout).
--
-- Also adds the VOICE_ENABLED global kill switch setting (default: false).

-- 1. Insert the Voice Mode tool
INSERT INTO tools (identifier, name, description, is_active, created_at, updated_at)
SELECT
    'voice-mode',
    'Voice Mode',
    'Real-time voice conversations in Nexus using AI speech providers',
    true,
    NOW(),
    NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM tools WHERE identifier = 'voice-mode'
);

-- 2. Add VOICE_ENABLED global kill switch setting (default disabled)
INSERT INTO settings (key, value, description, category, is_secret)
VALUES (
    'VOICE_ENABLED',
    'false',
    'Global kill switch for voice mode. Set to "true" to enable voice features.',
    'voice',
    false
)
ON CONFLICT (key) DO NOTHING;
