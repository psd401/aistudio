-- Migration 058: nexus_mcp_user_tokens table for encrypted OAuth storage
-- Part of Epic #774 - Nexus MCP Connectors
-- Issue #776
--
-- ENCRYPTION CONTRACT: encrypted_access_token and encrypted_refresh_token
-- MUST be written only via lib/mcp/token-encryption.ts (to be implemented in a
-- follow-up issue). Plain-text writes are not enforced at the DB layer.
--
-- CASCADE NOTE: ON DELETE CASCADE removes token rows from DB but does NOT revoke
-- tokens at the OAuth provider. The application layer MUST call the provider's
-- token revocation endpoint before deleting a user or server record.
-- Dependencies: users table (002), nexus_mcp_servers (028),
--               update_updated_at_column() (017)

CREATE TABLE IF NOT EXISTS nexus_mcp_user_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id UUID NOT NULL REFERENCES nexus_mcp_servers(id) ON DELETE CASCADE,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  scope TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint as idempotent index (CREATE TABLE IF NOT EXISTS skips inline constraints)
CREATE UNIQUE INDEX IF NOT EXISTS nexus_mcp_user_tokens_user_server_unique
  ON nexus_mcp_user_tokens(user_id, server_id);

-- server_id index for lookups by server (user_id is covered by the composite unique index)
CREATE INDEX IF NOT EXISTS idx_mcp_user_tokens_server ON nexus_mcp_user_tokens(server_id);

-- TRIGGERS
-- Uses shared update_updated_at_column() from migration 017
DROP TRIGGER IF EXISTS trg_nexus_mcp_user_tokens_updated_at ON nexus_mcp_user_tokens;
CREATE TRIGGER trg_nexus_mcp_user_tokens_updated_at
  BEFORE UPDATE ON nexus_mcp_user_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
