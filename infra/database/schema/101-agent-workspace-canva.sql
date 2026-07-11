-- Migration 101: Canva OAuth consent support.
--
-- Adds the 'canva' credential kind to the consent-nonce table so a user can
-- authorize their OWN Canva account once via /agent-connect-canva. The refresh
-- token is stored at psd-agent-creds/{env}/user/{email}/canva (a different
-- secret path — this table only provides the nonce + per-owner rate-limit +
-- replay protection, exactly like the 'plaud' kind, migration 093).
--
-- Canva's Connect REST API is a spec-compliant OAuth 2.0 authorization server
-- (authorization_code + refresh_token, PKCE S256 required, CONFIDENTIAL client
-- — client_id + client_secret from the Canva Developer Portal). The PKCE
-- code_verifier reuses the existing code_verifier column added in migration 093
-- (generated at consent-link mint time, stored here, read back at the callback
-- to exchange the authorization code — only the S256 challenge ever leaves in a
-- URL). No new column is required; this migration only widens the CHECK
-- constraint. Migrations 001-005 are untouched (postgres-owned; this table was
-- created later and is owned by the migration role).

UPDATE migration_log SET status = 'completed'
WHERE description = '101-agent-workspace-canva.sql' AND status = 'failed';

ALTER TABLE psd_agent_workspace_consent_nonces
    DROP CONSTRAINT IF EXISTS psd_agent_workspace_consent_nonces_token_kind_check;

ALTER TABLE psd_agent_workspace_consent_nonces
    ADD CONSTRAINT psd_agent_workspace_consent_nonces_token_kind_check
    CHECK (token_kind IN ('agent_account', 'user_account', 'cognito_data', 'plaud', 'canva'));
