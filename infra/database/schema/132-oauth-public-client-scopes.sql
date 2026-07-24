-- =====================================================
-- Migration: 132-oauth-public-client-scopes.sql
-- Description: Enforce the required OIDC scopes for public PKCE clients
-- Dependencies: 053-oauth-provider-tables.sql,
--               130-oauth-application-types.sql
--
-- Public authorization-code clients need the OIDC identity scopes requested by
-- Atrium Capture and offline access for their registered refresh-token grant.
-- Repair existing rows in place so deployed clients keep the same client IDs
-- and redirects, then protect direct database registrations with a constraint.
--
-- Rollback:
-- ALTER TABLE oauth_clients DROP CONSTRAINT IF EXISTS
--   oauth_clients_public_oidc_scopes;
-- Scope additions are intentionally retained on rollback because removing them
-- would immediately break deployed public clients.
-- =====================================================

UPDATE oauth_clients
SET
  allowed_scopes =
    allowed_scopes
    || CASE
      WHEN allowed_scopes ? 'openid' THEN '[]'::jsonb
      ELSE '["openid"]'::jsonb
    END
    || CASE
      WHEN allowed_scopes ? 'profile' THEN '[]'::jsonb
      ELSE '["profile"]'::jsonb
    END
    || CASE
      WHEN allowed_scopes ? 'offline_access' THEN '[]'::jsonb
      ELSE '["offline_access"]'::jsonb
    END,
  updated_at = NOW()
WHERE token_endpoint_auth_method = 'none'
  AND require_pkce = true
  AND grant_types @> '["authorization_code"]'::jsonb
  AND NOT (
    allowed_scopes @> '["openid", "profile", "offline_access"]'::jsonb
  );

ALTER TABLE oauth_clients
  DROP CONSTRAINT IF EXISTS oauth_clients_public_oidc_scopes;
ALTER TABLE oauth_clients
  ADD CONSTRAINT oauth_clients_public_oidc_scopes
  CHECK (
    token_endpoint_auth_method <> 'none'
    OR require_pkce <> true
    OR NOT (grant_types @> '["authorization_code"]'::jsonb)
    OR allowed_scopes @> '["openid", "profile", "offline_access"]'::jsonb
  );
