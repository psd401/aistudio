-- Migration 077: Widen psd_agent_workspace_consent_nonces.token_kind to allow
-- 'cognito_data' alongside the existing 'agent_account' / 'user_account'.
--
-- Why: the data-MCP integration reuses this table's nonce + per-owner
-- rate-limit infrastructure to issue one-time consent URLs for Cognito
-- refresh-token capture (kind = 'cognito_data'). The Drizzle schema's
-- `$type<>()` declaration was widened in the application code, but the
-- DB-level CHECK constraint from migration 073 still only allowed the
-- two original kinds, so inserts with 'cognito_data' failed with:
--
--   new row for relation "psd_agent_workspace_consent_nonces" violates
--   check constraint "psd_agent_workspace_consent_nonces_token_kind_check"
--
-- The column is varchar(16); 'cognito_data' is 12 chars so no length
-- change is needed. Only the CHECK constraint needs to be re-stated.
--
-- The psd_agent_workspace_tokens table keeps its narrower CHECK
-- (agent_account, user_account only) because the agent's cognito-refresh
-- credential is stored at a different Secrets Manager path —
-- psd-agent-creds/{env}/user/{email}/cognito-refresh — not in this table.

UPDATE migration_log SET status = 'completed'
WHERE description = '077-agent-workspace-consent-nonces-cognito-data.sql' AND status = 'failed';

ALTER TABLE psd_agent_workspace_consent_nonces
    DROP CONSTRAINT IF EXISTS psd_agent_workspace_consent_nonces_token_kind_check;

ALTER TABLE psd_agent_workspace_consent_nonces
    ADD CONSTRAINT psd_agent_workspace_consent_nonces_token_kind_check
    CHECK (token_kind IN ('agent_account', 'user_account', 'cognito_data'));
