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
-- Summary
-- ============================================================================

DO $$
DECLARE
    user_count INT;
    role_count INT;
    model_count INT;
    tool_count INT;
BEGIN
    SELECT COUNT(*) INTO user_count FROM users;
    SELECT COUNT(*) INTO role_count FROM roles;
    SELECT COUNT(*) INTO model_count FROM ai_models WHERE active = true;
    SELECT COUNT(*) INTO tool_count FROM tools WHERE is_active = true;

    RAISE NOTICE '';
    RAISE NOTICE '==========================================';
    RAISE NOTICE 'Local Seed Data Applied Successfully';
    RAISE NOTICE '==========================================';
    RAISE NOTICE 'Users: %', user_count;
    RAISE NOTICE 'Roles: %', role_count;
    RAISE NOTICE 'Active AI Models: %', model_count;
    RAISE NOTICE 'Active Tools: %', tool_count;
    RAISE NOTICE '';
    RAISE NOTICE 'Test accounts created:';
    RAISE NOTICE '  - test@example.com (administrator)';
    RAISE NOTICE '  - staff@example.com (staff)';
    RAISE NOTICE '  - student@example.com (student)';
    RAISE NOTICE '==========================================';
END $$;
