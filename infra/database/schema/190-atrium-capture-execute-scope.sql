-- =====================================================
-- Migration: 190-atrium-capture-execute-scope.sql
-- Description: Allow the two first-party Atrium Capture clients to request
--              assistants:execute for the district Capture Guide Writer.
-- Dependencies: 134-oauth-first-party-clients.sql,
--               138-atrium-capture-browser-registration.sql
--
-- Scope is appended only to the two exact client ids, only while each row
-- still matches its first-party public PKCE profile, and only if the scope is
-- not already present. Re-running is a no-op.
--
-- Rollback:
-- UPDATE oauth_clients
-- SET allowed_scopes = allowed_scopes - 'assistants:execute', updated_at = NOW()
-- WHERE client_id IN (
--   'ae781263-20c0-4b0c-8a34-8be01ab72fb1',
--   'fbdaa815-1b0f-435b-805f-1732805720c1'
-- );
-- =====================================================

UPDATE oauth_clients
SET
  allowed_scopes = allowed_scopes || '"assistants:execute"'::jsonb,
  updated_at = NOW()
WHERE client_id IN (
    'ae781263-20c0-4b0c-8a34-8be01ab72fb1',
    'fbdaa815-1b0f-435b-805f-1732805720c1'
  )
  AND is_first_party = true
  AND token_endpoint_auth_method = 'none'
  AND client_secret_hash IS NULL
  AND require_pkce = true
  AND is_active = true
  AND jsonb_typeof(allowed_scopes) = 'array'
  AND NOT allowed_scopes ? 'assistants:execute';
