-- Migration 059: Add MCP OAuth client registration column
-- Part of Epic #774 — Nexus MCP Connectors (Issue #797)
--
-- Stores dynamically registered OAuthClientInformation per MCP server.
-- The client_secret (if present) is encrypted via encryptToken() before storage.
-- This column is shared across users — dynamic client registration is per-server.

ALTER TABLE nexus_mcp_servers
  ADD COLUMN IF NOT EXISTS mcp_oauth_registration jsonb DEFAULT NULL;

COMMENT ON COLUMN nexus_mcp_servers.mcp_oauth_registration IS
  'Dynamic OAuth client registration (client_id, encrypted_client_secret, etc). Set by MCP auth flow.';
