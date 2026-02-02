-- =====================================================
-- Migration: 053-oauth-provider-tables.sql
-- Description: OAuth2/OIDC provider tables for MCP Server auth
-- Issue: #686
-- Part of: Issue #686 (MCP Server + OAuth2/OIDC Provider Phase 3)
-- Dependencies: users table (002), update_updated_at_column() (017)
--
-- Purpose:
-- 1. Create oauth_clients table for registered OAuth2 clients
-- 2. Create oauth_authorization_codes table for auth code flow
-- 3. Create oauth_access_tokens table for issued JWTs
-- 4. Create oauth_refresh_tokens table with rotation support
-- 5. Create jwks_keys table for JWT signing key metadata
--
-- Rollback:
-- DROP TABLE IF EXISTS oauth_refresh_tokens;
-- DROP TABLE IF EXISTS oauth_access_tokens;
-- DROP TABLE IF EXISTS oauth_authorization_codes;
-- DROP TABLE IF EXISTS oauth_clients;
-- DROP TABLE IF EXISTS jwks_keys;
-- =====================================================

-- =====================================================
-- PART 1: OAUTH CLIENTS
-- Registered applications that can request tokens.
-- Supports both confidential (with secret) and public (PKCE-only) clients.
-- =====================================================

CREATE TABLE IF NOT EXISTS oauth_clients (
  id SERIAL PRIMARY KEY,
  client_id VARCHAR(255) NOT NULL UNIQUE,
  client_name VARCHAR(255) NOT NULL,
  client_secret_hash VARCHAR(255),  -- Argon2id hash; NULL for public clients
  redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  grant_types JSONB NOT NULL DEFAULT '["authorization_code"]'::jsonb,
  response_types JSONB NOT NULL DEFAULT '["code"]'::jsonb,
  token_endpoint_auth_method VARCHAR(50) NOT NULL DEFAULT 'none',
  require_pkce BOOLEAN NOT NULL DEFAULT true,
  access_token_ttl INTEGER NOT NULL DEFAULT 900,      -- seconds (15 min)
  refresh_token_ttl INTEGER NOT NULL DEFAULT 86400,    -- seconds (24 hr)
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- =====================================================
-- PART 2: AUTHORIZATION CODES
-- Short-lived codes exchanged for tokens (auth code flow).
-- =====================================================

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id SERIAL PRIMARY KEY,
  code_hash VARCHAR(128) NOT NULL UNIQUE,
  client_id VARCHAR(255) NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  code_challenge VARCHAR(128),
  code_challenge_method VARCHAR(10) DEFAULT 'S256',
  nonce VARCHAR(255),
  consumed_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- =====================================================
-- PART 3: ACCESS TOKENS
-- Tracks issued JWTs for revocation and introspection.
-- =====================================================

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  id SERIAL PRIMARY KEY,
  jti VARCHAR(255) NOT NULL UNIQUE,
  client_id VARCHAR(255) NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  revoked_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- =====================================================
-- PART 4: REFRESH TOKENS
-- Supports token rotation with grace period.
-- =====================================================

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id SERIAL PRIMARY KEY,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  client_id VARCHAR(255) NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token_jti VARCHAR(255) REFERENCES oauth_access_tokens(jti) ON DELETE SET NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  rotated_at TIMESTAMP WITH TIME ZONE,         -- set when rotated out
  rotated_to_id INTEGER REFERENCES oauth_refresh_tokens(id),
  revoked_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- =====================================================
-- PART 5: JWKS KEYS
-- JWT signing key metadata. KMS keys or local dev RSA.
-- =====================================================

CREATE TABLE IF NOT EXISTS jwks_keys (
  id SERIAL PRIMARY KEY,
  kid VARCHAR(255) NOT NULL UNIQUE,
  kms_key_arn VARCHAR(512),              -- NULL for local dev
  algorithm VARCHAR(10) NOT NULL DEFAULT 'RS256',
  public_key_pem TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- =====================================================
-- INDEXES
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_is_active ON oauth_clients(is_active);

CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_client_id ON oauth_authorization_codes(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_expires_at ON oauth_authorization_codes(expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_client_id ON oauth_access_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_user_id ON oauth_access_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_expires_at ON oauth_access_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_client_id ON oauth_refresh_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_user_id ON oauth_refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_expires_at ON oauth_refresh_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_jwks_keys_is_active ON jwks_keys(is_active);

-- =====================================================
-- TRIGGERS
-- Uses shared update_updated_at_column() from migration 017
-- =====================================================

DROP TRIGGER IF EXISTS trg_oauth_clients_updated_at ON oauth_clients;
CREATE TRIGGER trg_oauth_clients_updated_at
  BEFORE UPDATE ON oauth_clients
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- NAVIGATION: Add OAuth Clients to Admin section
-- Parent ID 11 is the "Admin" section, position 27
-- =====================================================

INSERT INTO navigation_items (label, icon, link, parent_id, requires_role, position, is_active, type, description)
SELECT 'OAuth Clients', 'IconKey', '/admin/oauth-clients', 11, 'administrator', 27, true, 'link', 'Manage OAuth2/OIDC client applications'
WHERE NOT EXISTS (
    SELECT 1 FROM navigation_items WHERE link = '/admin/oauth-clients'
);
