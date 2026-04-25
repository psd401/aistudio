-- Migration 071: Agent Google Workspace token manifest
-- Part of #912 — Epic: Agent-Owned Google Workspace Integration
--
-- Adds 2 tables for managing Google Workspace OAuth tokens for agent accounts.
-- Modelled on migration 070 (agent-skills-platform.sql) and 065
-- (agent-telemetry-tables.sql), which are the closest proven-working
-- precedents for agent-related schema in this codebase.
--
-- Design choices enforced by the db-init Lambda's SQL splitter:
--   - No PL/pgSQL triggers (CREATE FUNCTION breaks the splitter)
--   - No DROP TYPE (splitter treats it as a multi-line block)
--   - No DO $$ blocks (splitter closes them prematurely on inner `);`)
--   - No ENUM types — use VARCHAR + CHECK constraint instead
--
-- Application code maintains updated_at explicitly on every UPDATE.

-- Mark any previous failed attempts as completed so the runner stops retrying.
UPDATE migration_log SET status = 'completed'
WHERE description = '071-agent-workspace-tokens.sql' AND status = 'failed';

-- Clean up partial leftovers from earlier failed runs. Safe on fresh DBs.
DROP TABLE IF EXISTS psd_agent_workspace_consent_nonces CASCADE;
DROP TABLE IF EXISTS psd_agent_workspace_tokens CASCADE;

-- psd_agent_workspace_tokens: manifest of Google Workspace OAuth connections
-- per user. One row per user — their agent account's OAuth state.
-- Secrets (refresh tokens) live in AWS Secrets Manager, not here.
CREATE TABLE IF NOT EXISTS psd_agent_workspace_tokens (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_email         VARCHAR(255) NOT NULL,
    agent_email         VARCHAR(255) NOT NULL,
    status              VARCHAR(16) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'active', 'stale', 'revoked')),
    granted_scopes      JSONB NOT NULL DEFAULT '[]'::jsonb,
    secrets_manager_arn TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_verified_at    TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workspace_tokens_owner
    ON psd_agent_workspace_tokens (owner_user_id);

CREATE INDEX IF NOT EXISTS idx_agent_workspace_tokens_status
    ON psd_agent_workspace_tokens (status)
    WHERE status != 'active';

-- psd_agent_workspace_consent_nonces: one-time-use nonces for consent links.
-- Each nonce is consumed when the OAuth callback completes, preventing replay.
-- CLEANUP: handled by the psd-agent-workspace-nonce-cleanup Lambda, scheduled
-- daily by AgentWorkspaceNonceCleanupSchedule in agent-platform-stack.ts.
-- The Lambda DELETEs rows older than RETENTION_DAYS (default 7) in batches.
-- The `idx_agent_workspace_nonces_cleanup` index supports the range delete.
CREATE TABLE IF NOT EXISTS psd_agent_workspace_consent_nonces (
    nonce       VARCHAR(64) PRIMARY KEY,
    owner_email VARCHAR(255) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_workspace_nonces_cleanup
    ON psd_agent_workspace_consent_nonces (created_at);
