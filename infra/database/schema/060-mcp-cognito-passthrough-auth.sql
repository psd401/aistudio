-- Migration 060: Add cognito_passthrough auth type for MCP connectors
-- Issue #803 — PSD Data MCP integration
--
-- Adds 'cognito_passthrough' to the auth_type CHECK constraint on nexus_mcp_servers.
-- This auth type forwards the user's Cognito ID token as a Bearer header,
-- enabling integration with MCP servers that validate Cognito JWTs directly.

-- Drop existing CHECK constraint and recreate with new value
ALTER TABLE nexus_mcp_servers DROP CONSTRAINT IF EXISTS nexus_mcp_servers_auth_type_check;
ALTER TABLE nexus_mcp_servers ADD CONSTRAINT nexus_mcp_servers_auth_type_check
  CHECK (auth_type IN ('api_key', 'oauth', 'jwt', 'none', 'cognito_passthrough'));
