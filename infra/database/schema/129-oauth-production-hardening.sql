-- =====================================================
-- Migration: 129-oauth-production-hardening.sql
-- Description: Durable oidc-provider state and complete token payloads
-- Issue: #1285
-- Dependencies: 053-oauth-provider-tables.sql
--
-- The oidc-provider adapter previously kept Session, Interaction, and Grant
-- records in a process-local Map. Authorization could therefore fail whenever
-- an ALB sent the next request to another ECS task or a task restarted. The
-- structured token tables also discarded provider fields such as grantId,
-- which refresh-token rotation needs after a restart.
--
-- Provider identifiers are high-entropy bearer values. Only SHA-256 digests are
-- stored; raw authorization codes, access tokens, refresh tokens, session ids,
-- and interaction ids never enter the database.
--
-- Rollback:
-- DROP TABLE IF EXISTS oauth_provider_records;
-- ALTER TABLE oauth_refresh_tokens DROP COLUMN IF EXISTS adapter_payload,
--   DROP COLUMN IF EXISTS grant_id;
-- ALTER TABLE oauth_access_tokens DROP COLUMN IF EXISTS adapter_payload,
--   DROP COLUMN IF EXISTS grant_id;
-- ALTER TABLE oauth_authorization_codes DROP COLUMN IF EXISTS adapter_payload,
--   DROP COLUMN IF EXISTS grant_id;
-- =====================================================

ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS grant_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS adapter_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS grant_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS adapter_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS grant_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS adapter_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_grant_id
  ON oauth_authorization_codes(grant_id)
  WHERE grant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_grant_id
  ON oauth_access_tokens(grant_id)
  WHERE grant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_grant_id
  ON oauth_refresh_tokens(grant_id)
  WHERE grant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oauth_provider_records (
  model VARCHAR(64) NOT NULL,
  id_hash VARCHAR(64) NOT NULL,
  uid VARCHAR(255),
  grant_id VARCHAR(255),
  adapter_payload JSONB NOT NULL,
  consumed_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (model, id_hash)
);

CREATE INDEX IF NOT EXISTS idx_oauth_provider_records_uid
  ON oauth_provider_records(model, uid)
  WHERE uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_provider_records_grant_id
  ON oauth_provider_records(grant_id)
  WHERE grant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_provider_records_expires_at
  ON oauth_provider_records(expires_at)
  WHERE expires_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_oauth_provider_records_updated_at
  ON oauth_provider_records;
CREATE TRIGGER trg_oauth_provider_records_updated_at
  BEFORE UPDATE ON oauth_provider_records
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
