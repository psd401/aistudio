-- Migration 070: Agent Skills Platform
-- Part of #910 — Epic: Agent Skills Platform
--
-- Adds:
--   psd_agent_skills            — skill registry (shared, per-user, draft)
--   psd_agent_skill_audit       — append-only audit log for skill lifecycle events
--   psd_agent_credentials_audit — append-only audit log for credential provisioning
--   psd_agent_credential_reads  — telemetry for credential reads (name only, never value)
--   psd_agent_credential_requests — pending credential requests linked to Freshservice tickets
--
-- Enums:
--   agent_skill_scope           — shared, user, draft, rejected
--   agent_skill_scan_status     — clean, flagged, pending

-- 1. Enums
DO $$ BEGIN
    CREATE TYPE agent_skill_scope AS ENUM ('shared', 'user', 'draft', 'rejected');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE agent_skill_scan_status AS ENUM ('clean', 'flagged', 'pending');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 2. psd_agent_skills — skill registry
CREATE TABLE IF NOT EXISTS psd_agent_skills (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    scope           agent_skill_scope NOT NULL DEFAULT 'draft',
    owner_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    s3_key          TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    summary         TEXT NOT NULL,
    scan_status     agent_skill_scan_status NOT NULL DEFAULT 'pending',
    scan_findings   JSONB,
    approved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    approved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agent_skills_scope
    ON psd_agent_skills (scope);

CREATE INDEX IF NOT EXISTS idx_agent_skills_owner
    ON psd_agent_skills (owner_user_id)
    WHERE owner_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_skills_scan_status
    ON psd_agent_skills (scan_status)
    WHERE scan_status != 'clean';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_name_owner
    ON psd_agent_skills (name, owner_user_id, scope);

-- updated_at trigger for psd_agent_skills
DO $$ BEGIN
    CREATE OR REPLACE FUNCTION update_psd_agent_skills_updated_at()
    RETURNS TRIGGER AS $func$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;
END $$;

DROP TRIGGER IF EXISTS trg_psd_agent_skills_updated_at ON psd_agent_skills;
CREATE TRIGGER trg_psd_agent_skills_updated_at
    BEFORE UPDATE ON psd_agent_skills
    FOR EACH ROW EXECUTE FUNCTION update_psd_agent_skills_updated_at();

-- 3. psd_agent_skill_audit — append-only lifecycle log
CREATE TABLE IF NOT EXISTS psd_agent_skill_audit (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    skill_id        UUID NOT NULL REFERENCES psd_agent_skills(id) ON DELETE CASCADE,
    action          VARCHAR(64) NOT NULL,
    actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    details         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_skill_audit_skill
    ON psd_agent_skill_audit (skill_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_skill_audit_action
    ON psd_agent_skill_audit (action, created_at DESC);

-- 4. psd_agent_credentials_audit — append-only credential provisioning log
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

-- 5. psd_agent_credential_reads — telemetry for credential access (never values)
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

-- 6. psd_agent_credential_requests — pending credential requests
CREATE TABLE IF NOT EXISTS psd_agent_credential_requests (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    credential_name VARCHAR(255) NOT NULL,
    reason          TEXT NOT NULL,
    skill_context   TEXT,
    requested_by    VARCHAR(255) NOT NULL,
    freshservice_ticket_id VARCHAR(64),
    status          VARCHAR(32) NOT NULL DEFAULT 'pending',
    resolved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_cred_requests_status
    ON psd_agent_credential_requests (status)
    WHERE status = 'pending';

-- updated_at trigger for psd_agent_credential_requests
DO $$ BEGIN
    CREATE OR REPLACE FUNCTION update_psd_agent_credential_requests_updated_at()
    RETURNS TRIGGER AS $func$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;
END $$;

DROP TRIGGER IF EXISTS trg_psd_agent_credential_requests_updated_at ON psd_agent_credential_requests;
CREATE TRIGGER trg_psd_agent_credential_requests_updated_at
    BEFORE UPDATE ON psd_agent_credential_requests
    FOR EACH ROW EXECUTE FUNCTION update_psd_agent_credential_requests_updated_at();
