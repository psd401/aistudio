-- Migration 070: Agent Skills Platform
-- Part of #910 — Epic: Agent Skills Platform
--
-- Adds 5 tables for the agent skills platform. Modelled on migration 065
-- (agent-telemetry-tables.sql), which is the closest proven-working
-- precedent for agent-related schema in this codebase.
--
-- Design choices enforced by the db-init Lambda's SQL splitter:
--   - No PL/pgSQL triggers (CREATE FUNCTION breaks the splitter)
--   - No DROP TYPE (splitter treats it as a multi-line block and produces
--     multi-statement SQL that Aurora Data API rejects)
--   - No DO $$ blocks (splitter closes them prematurely on inner `);`)
--   - No ENUM types — use VARCHAR + CHECK constraint instead (matches
--     the 065 pattern; equivalent semantics at the app layer)
--
-- Application code maintains updated_at explicitly on every UPDATE.
-- The prior partial-state leftover (enum types + psd_agent_skills table
-- with enum columns) is cleaned up by the DROP TABLE IF EXISTS CASCADE
-- block; the two orphan enum types `agent_skill_scope` /
-- `agent_skill_scan_status` are left in place (no DROP TYPE) — they are
-- harmless and referenced by nothing after this migration runs.

-- Mark any previous failed attempts as completed so the runner stops retrying.
UPDATE migration_log SET status = 'completed'
WHERE description = '070-agent-skills-platform.sql' AND status = 'failed';

-- Clean up partial leftovers from earlier failed runs. Safe on fresh DBs.
DROP TABLE IF EXISTS psd_agent_credential_requests CASCADE;
DROP TABLE IF EXISTS psd_agent_credential_reads CASCADE;
DROP TABLE IF EXISTS psd_agent_credentials_audit CASCADE;
DROP TABLE IF EXISTS psd_agent_skill_audit CASCADE;
DROP TABLE IF EXISTS psd_agent_skills CASCADE;

-- psd_agent_skills: skill registry (shared, per-user, draft, rejected)
CREATE TABLE IF NOT EXISTS psd_agent_skills (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    scope           VARCHAR(16) NOT NULL DEFAULT 'draft'
                    CHECK (scope IN ('shared', 'user', 'draft', 'rejected')),
    owner_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    s3_key          TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    summary         TEXT NOT NULL,
    scan_status     VARCHAR(16) NOT NULL DEFAULT 'pending'
                    CHECK (scan_status IN ('clean', 'flagged', 'pending')),
    scan_findings   JSONB,
    approved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    approved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_skills_scope
    ON psd_agent_skills (scope);

CREATE INDEX IF NOT EXISTS idx_agent_skills_owner
    ON psd_agent_skills (owner_user_id)
    WHERE owner_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_skills_scan_status
    ON psd_agent_skills (scan_status)
    WHERE scan_status != 'clean';

CREATE INDEX IF NOT EXISTS idx_agent_skills_scope_clean
    ON psd_agent_skills (scope, name)
    WHERE scan_status = 'clean';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_shared_name
    ON psd_agent_skills (name)
    WHERE scope = 'shared';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_user_name_owner
    ON psd_agent_skills (name, owner_user_id)
    WHERE scope = 'user';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_draft_name_owner
    ON psd_agent_skills (name, owner_user_id)
    WHERE scope = 'draft';

-- psd_agent_skill_audit: append-only lifecycle log. skill_id uses ON DELETE
-- SET NULL so audit rows survive the deletion of the skill they describe.
CREATE TABLE IF NOT EXISTS psd_agent_skill_audit (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    skill_id        UUID REFERENCES psd_agent_skills(id) ON DELETE SET NULL,
    action          VARCHAR(64) NOT NULL,
    actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    details         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_skill_audit_skill
    ON psd_agent_skill_audit (skill_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_skill_audit_action
    ON psd_agent_skill_audit (action, created_at DESC);

-- psd_agent_credentials_audit: credential provisioning log
CREATE TABLE IF NOT EXISTS psd_agent_credentials_audit (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    credential_name VARCHAR(255) NOT NULL,
    scope           VARCHAR(32) NOT NULL,
    action          VARCHAR(64) NOT NULL,
    actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    details         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_creds_audit_name
    ON psd_agent_credentials_audit (credential_name, created_at DESC);

-- psd_agent_credential_reads: telemetry for credential access (names only)
CREATE TABLE IF NOT EXISTS psd_agent_credential_reads (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    credential_name VARCHAR(255) NOT NULL,
    user_id         VARCHAR(255) NOT NULL,
    session_id      VARCHAR(512),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_cred_reads_name
    ON psd_agent_credential_reads (credential_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_cred_reads_user
    ON psd_agent_credential_reads (user_id, created_at DESC);

-- psd_agent_credential_requests: pending credential requests from agents
CREATE TABLE IF NOT EXISTS psd_agent_credential_requests (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    credential_name VARCHAR(255) NOT NULL,
    reason          TEXT NOT NULL,
    skill_context   TEXT,
    requested_by    VARCHAR(255) NOT NULL,
    freshservice_ticket_id VARCHAR(64),
    status          VARCHAR(32) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'fulfilled', 'rejected')),
    resolved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_cred_requests_status
    ON psd_agent_credential_requests (status)
    WHERE status = 'pending';
