-- Migration 138: Replace the Atrium Capture browser-extension registration.
--
-- The Chrome Web Store build has a new permanent extension id. OAuth redirect
-- registration and browser CORS trust are independent: this migration updates
-- only the persisted callback, while lib/oauth/client-origin-policy.ts owns the
-- exact chrome-extension:// origin allowlist.
--
-- The exact old callback and public-PKCE profile guard against overwriting an
-- administrator-modified or unrelated client. Re-running after a successful
-- update is an intentional no-op.
--
-- Rollback:
-- UPDATE oauth_clients
-- SET
--   redirect_uris = '["https://jldnpmcpimhabiphcglkbgmbffpoocpo.chromiumapp.org/atrium"]'::jsonb,
--   updated_at = NOW()
-- WHERE client_id = 'ae781263-20c0-4b0c-8a34-8be01ab72fb1'
--   AND redirect_uris = '["https://eomlblaiglafndhplfhilmdcaofhkkbj.chromiumapp.org/atrium"]'::jsonb;

UPDATE oauth_clients
SET
  redirect_uris = '["https://eomlblaiglafndhplfhilmdcaofhkkbj.chromiumapp.org/atrium"]'::jsonb,
  updated_at = NOW()
WHERE client_id = 'ae781263-20c0-4b0c-8a34-8be01ab72fb1'
  AND application_type = 'browser_extension'
  AND token_endpoint_auth_method = 'none'
  AND client_secret_hash IS NULL
  AND require_pkce = true
  AND is_first_party = true
  AND is_active = true
  AND redirect_uris = '["https://jldnpmcpimhabiphcglkbgmbffpoocpo.chromiumapp.org/atrium"]'::jsonb;
