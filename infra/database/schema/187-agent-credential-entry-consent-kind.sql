-- Migration 187: One-time credential-entry links (issue #1887).
--
-- Adds the 'credential_entry' consent kind so a user can type an API key or
-- vendor token into /agent-connect-credential instead of pasting it into a
-- Google Chat message with the agent. The secret is written through the
-- existing owner-scoped credential broker put path
-- (psd-agent-creds/{env}/user/{email}/{name}); this table only supplies the
-- nonce, the per-owner rate limit, and single-use replay protection, exactly
-- like the 'cognito_data' (077), 'plaud' (093), and 'canva' (101) kinds.
--
-- No new column is required. 'credential_entry' is 16 characters, which fits
-- the existing token_kind VARCHAR(16); the target credential NAME travels in
-- the signed consent JWT (`cred` claim), not in this table. No PKCE
-- code_verifier is generated for this kind — there is no OAuth round trip.
--
-- Migrations 001-005 are untouched (postgres-owned); this table was created in
-- migration 071 and is owned by the migration role.
--
-- Rollback:
-- ALTER TABLE psd_agent_workspace_consent_nonces
--   DROP CONSTRAINT IF EXISTS psd_agent_workspace_consent_nonces_token_kind_check;
-- ALTER TABLE psd_agent_workspace_consent_nonces
--   ADD CONSTRAINT psd_agent_workspace_consent_nonces_token_kind_check
--   CHECK (token_kind IN (
--     'agent_account', 'user_account', 'cognito_data', 'plaud', 'canva', 'aistudio'
--   ));

UPDATE migration_log SET status = 'completed'
WHERE description = '187-agent-credential-entry-consent-kind.sql' AND status = 'failed';

ALTER TABLE psd_agent_workspace_consent_nonces
  DROP CONSTRAINT IF EXISTS psd_agent_workspace_consent_nonces_token_kind_check;

ALTER TABLE psd_agent_workspace_consent_nonces
  ADD CONSTRAINT psd_agent_workspace_consent_nonces_token_kind_check
  CHECK (token_kind IN (
    'agent_account',
    'user_account',
    'cognito_data',
    'plaud',
    'canva',
    'aistudio',
    'credential_entry'
  ));
