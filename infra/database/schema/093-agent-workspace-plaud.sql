-- Migration 080: Plaud OAuth consent support.
--
-- Adds the 'plaud' credential kind to the consent-nonce table and a
-- code_verifier column for the PKCE (S256) leg of Plaud's OAuth 2.1 flow.
--
-- Plaud's MCP server (https://mcp.plaud.ai) is a spec-compliant OAuth 2.1
-- authorization server (authorization_code + refresh_token, PKCE required,
-- public client via Dynamic Client Registration). Each user authorizes their
-- own Plaud account once via /agent-connect-plaud; the refresh token is stored
-- at psd-agent-creds/{env}/user/{email}/plaud (a different secret path — this
-- table only provides the nonce + per-owner rate-limit + replay protection,
-- exactly like the 'cognito_data' kind, migration 077).
--
-- The code_verifier is generated at consent-link mint time, stored here, and
-- read back at the callback to exchange the authorization code. It is NEVER
-- placed in the URL (only the S256 challenge is). Nullable because the other
-- kinds don't use PKCE. varchar(128) = the RFC 7636 maximum verifier length.

UPDATE migration_log SET status = 'completed'
WHERE description = '093-agent-workspace-plaud.sql' AND status = 'failed';

ALTER TABLE psd_agent_workspace_consent_nonces
    DROP CONSTRAINT IF EXISTS psd_agent_workspace_consent_nonces_token_kind_check;

ALTER TABLE psd_agent_workspace_consent_nonces
    ADD CONSTRAINT psd_agent_workspace_consent_nonces_token_kind_check
    CHECK (token_kind IN ('agent_account', 'user_account', 'cognito_data', 'plaud'));

ALTER TABLE psd_agent_workspace_consent_nonces
    ADD COLUMN IF NOT EXISTS code_verifier varchar(128);
