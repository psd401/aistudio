-- Migration 058: nexus_mcp_user_tokens table for encrypted OAuth storage
-- Part of Epic #774 - Nexus MCP Connectors
-- Issue #776

CREATE TABLE IF NOT EXISTS nexus_mcp_user_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id UUID NOT NULL REFERENCES nexus_mcp_servers(id) ON DELETE CASCADE,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  scope VARCHAR(1000),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, server_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_user_tokens_user ON nexus_mcp_user_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_user_tokens_server ON nexus_mcp_user_tokens(server_id);
