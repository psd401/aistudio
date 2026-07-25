-- =====================================================
-- Migration: 134-oauth-first-party-clients.sql
-- Description: Explicit, audited first-party trust for Atrium Capture clients
-- Dependencies: 053-oauth-provider-tables.sql,
--               130-oauth-application-types.sql,
--               132-oauth-public-client-scopes.sql
--
-- Trust is never inferred from names, callbacks, application type, or scopes.
-- This migration backfills only the two production client IDs, and only while
-- each row still matches its expected public PKCE security profile and exact
-- redirect. Existing IDs, callbacks, grants, and secrets are not recreated.
--
-- Rollback:
-- DROP RULE IF EXISTS oauth_client_trust_audit_insert ON oauth_clients;
-- DROP RULE IF EXISTS oauth_client_trust_audit_update ON oauth_clients;
-- DROP TABLE IF EXISTS oauth_client_trust_audit;
-- ALTER TABLE oauth_clients DROP CONSTRAINT IF EXISTS
--   oauth_clients_first_party_security;
-- ALTER TABLE oauth_clients DROP COLUMN IF EXISTS is_first_party;
-- =====================================================

ALTER TABLE oauth_clients
  ADD COLUMN IF NOT EXISTS is_first_party BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE oauth_clients
  DROP CONSTRAINT IF EXISTS oauth_clients_first_party_security;
ALTER TABLE oauth_clients
  ADD CONSTRAINT oauth_clients_first_party_security
  CHECK (
    is_first_party = false
    OR (
      token_endpoint_auth_method = 'none'
      AND client_secret_hash IS NULL
      AND require_pkce = true
      AND grant_types @> '["authorization_code"]'::jsonb
    )
  );

CREATE TABLE IF NOT EXISTS oauth_client_trust_audit (
  id SERIAL PRIMARY KEY,
  client_id VARCHAR(255) NOT NULL,
  previous_is_first_party BOOLEAN NOT NULL,
  new_is_first_party BOOLEAN NOT NULL,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  change_source VARCHAR(128) NOT NULL,
  changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_client_trust_audit_client
  ON oauth_client_trust_audit (client_id, changed_at DESC);

-- Remove prior audit rules before the idempotent backfill. PostgreSQL does not
-- permit an UPDATE inside a data-modifying CTE when that table already has a
-- DO ALSO rule; both rules are recreated after the backfill below.
DROP RULE IF EXISTS oauth_client_trust_audit_insert ON oauth_clients;
DROP RULE IF EXISTS oauth_client_trust_audit_update ON oauth_clients;

WITH trusted_clients AS (
  UPDATE oauth_clients
  SET
    is_first_party = true,
    updated_at = NOW()
  WHERE is_first_party = false
    AND token_endpoint_auth_method = 'none'
    AND client_secret_hash IS NULL
    AND require_pkce = true
    AND is_active = true
    AND (
      (
        client_id = 'ae781263-20c0-4b0c-8a34-8be01ab72fb1'
        AND application_type = 'browser_extension'
        AND redirect_uris = '["https://jldnpmcpimhabiphcglkbgmbffpoocpo.chromiumapp.org/atrium"]'::jsonb
      )
      OR
      (
        client_id = 'fbdaa815-1b0f-435b-805f-1732805720c1'
        AND application_type = 'native'
        AND redirect_uris = '["org.psd401.atrium-capture:/oauth/callback"]'::jsonb
      )
    )
  RETURNING client_id
)
INSERT INTO oauth_client_trust_audit (
  client_id,
  previous_is_first_party,
  new_is_first_party,
  changed_by,
  change_source
)
SELECT
  client_id,
  false,
  true,
  NULL,
  'migration-134-exact-atrium-capture-backfill'
FROM trusted_clients;

CREATE OR REPLACE RULE oauth_client_trust_audit_update AS
  ON UPDATE TO oauth_clients
  WHERE NEW.is_first_party IS DISTINCT FROM OLD.is_first_party
  DO ALSO
    INSERT INTO oauth_client_trust_audit (
      client_id,
      previous_is_first_party,
      new_is_first_party,
      changed_by,
      change_source
    )
    VALUES (
      NEW.client_id,
      OLD.is_first_party,
      NEW.is_first_party,
      NULL,
      'database-rule'
    );

CREATE OR REPLACE RULE oauth_client_trust_audit_insert AS
  ON INSERT TO oauth_clients
  WHERE NEW.is_first_party = true
  DO ALSO
    INSERT INTO oauth_client_trust_audit (
      client_id,
      previous_is_first_party,
      new_is_first_party,
      changed_by,
      change_source
    )
    VALUES (
      NEW.client_id,
      false,
      true,
      NEW.created_by,
      'database-rule-insert'
    );
