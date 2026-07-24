-- =====================================================
-- Migration: 130-oauth-application-types.sql
-- Description: Explicit OAuth application types and public-client invariants
-- Issue: #1289
-- Dependencies: 053-oauth-provider-tables.sql
--
-- Browser extensions and native applications are public clients: they cannot
-- keep a secret and must use S256 PKCE. Redirect URI syntax is validated both
-- at registration and when the OIDC adapter loads a client.
--
-- Existing Chromium public clients are classified automatically. Other
-- existing clients remain web applications to avoid guessing native intent.
--
-- Rollback:
-- ALTER TABLE oauth_clients DROP CONSTRAINT IF EXISTS
--   oauth_clients_public_application_security;
-- ALTER TABLE oauth_clients DROP CONSTRAINT IF EXISTS
--   oauth_clients_application_type_valid;
-- ALTER TABLE oauth_clients DROP COLUMN IF EXISTS application_type;
-- =====================================================

ALTER TABLE oauth_clients
  ADD COLUMN IF NOT EXISTS application_type VARCHAR(32) NOT NULL DEFAULT 'web';

UPDATE oauth_clients
SET application_type = 'browser_extension'
WHERE token_endpoint_auth_method = 'none'
  AND client_secret_hash IS NULL
  AND require_pkce = true
  AND jsonb_array_length(redirect_uris) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(redirect_uris) AS redirect_uri(value)
    WHERE redirect_uri.value !~
      '^https://[a-p]{32}[.]chromiumapp[.]org/[^?#]+$'
  );

ALTER TABLE oauth_clients
  DROP CONSTRAINT IF EXISTS oauth_clients_application_type_valid;
ALTER TABLE oauth_clients
  ADD CONSTRAINT oauth_clients_application_type_valid
  CHECK (application_type IN ('web', 'browser_extension', 'native'));

ALTER TABLE oauth_clients
  DROP CONSTRAINT IF EXISTS oauth_clients_public_application_security;
ALTER TABLE oauth_clients
  ADD CONSTRAINT oauth_clients_public_application_security
  CHECK (
    application_type = 'web'
    OR (
      token_endpoint_auth_method = 'none'
      AND client_secret_hash IS NULL
      AND require_pkce = true
    )
  );
