-- Migration 070: Agent Skills Platform
-- Part of #910 — Epic: Agent Skills Platform
--
-- Adds 5 tables + 2 enums. No triggers (the db-init Lambda splitter mangles
-- CREATE FUNCTION / CREATE TRIGGER blocks when they precede other DDL).
-- Application code sets updated_at explicitly on every update.
--
-- DROPs at the top make this migration idempotent against the partial
-- leftover state from earlier failed runs (enums + psd_agent_skills +
-- indexes were created before the trigger split broke). The tables have
-- no user data yet — this is the first successful deploy of the feature.

DROP TABLE IF EXISTS psd_agent_credential_requests CASCADE;

DROP TABLE IF EXISTS psd_agent_credential_reads CASCADE;

DROP TABLE IF EXISTS psd_agent_credentials_audit CASCADE;

DROP TABLE IF EXISTS psd_agent_skill_audit CASCADE;

DROP TABLE IF EXISTS psd_agent_skills CASCADE;

DROP TYPE IF EXISTS agent_skill_scan_status CASCADE;

DROP TYPE IF EXISTS agent_skill_scope CASCADE;

CREATE TYPE agent_skill_scope AS ENUM ('shared', 'user', 'draft', 'rejected');

CREATE TYPE agent_skill_scan_status AS ENUM ('clean', 'flagged', 'pending');

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

CREATE INDEX IF NOT EXISTS idx_agent_skills_scope ON psd_agent_skills (scope);

CREATE INDEX IF NOT EXISTS idx_agent_skills_owner ON psd_agent_skills (owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_skills_scan_status ON psd_agent_skills (scan_status) WHERE scan_status != 'clean';

CREATE INDEX IF NOT EXISTS idx_agent_skills_scope_clean ON psd_agent_skills (scope, name) WHERE scan_status = 'clean';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_shared_name ON psd_agent_skills (name) WHERE scope = 'shared';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_user_name_owner ON psd_agent_skills (name, owner_user_id) WHERE scope = 'user';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_draft_name_owner ON psd_agent_skills (name, owner_user_id) WHERE scope = 'draft';

CREATE TABLE IF NOT EXISTS psd_agent_skill_audit (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    skill_id        UUID REFERENCES psd_agent_skills(id) ON DELETE SET NULL,
    action          VARCHAR(64) NOT NULL,
    actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    details         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_skill_audit_skill ON psd_agent_skill_audit (skill_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_skill_audit_action ON psd_agent_skill_audit (action, created_at DESC);

CREATE TABLE IF NOT EXISTS psd_agent_credentials_audit (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    credential_name VARCHAR(255) NOT NULL,
    scope           VARCHAR(32) NOT NULL,
    action          VARCHAR(64) NOT NULL,
    actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    details         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_creds_audit_name ON psd_agent_credentials_audit (credential_name, created_at DESC);

CREATE TABLE IF NOT EXISTS psd_agent_credential_reads (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    credential_name VARCHAR(255) NOT NULL,
    user_id         VARCHAR(255) NOT NULL,
    session_id      VARCHAR(512),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_cred_reads_name ON psd_agent_credential_reads (credential_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_cred_reads_user ON psd_agent_credential_reads (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS psd_agent_credential_requests (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    credential_name VARCHAR(255) NOT NULL,
    reason          TEXT NOT NULL,
    skill_context   TEXT,
    requested_by    VARCHAR(255) NOT NULL,
    freshservice_ticket_id VARCHAR(64),
    status          VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'rejected')),
    resolved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_cred_requests_status ON psd_agent_credential_requests (status) WHERE status = 'pending';
