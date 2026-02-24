-- Migration 061: Add inline OAuth credentials column to nexus_mcp_servers
-- Allows admins to store pre-registered OAuth client credentials directly on the connector
-- instead of requiring AWS Secrets Manager. clientSecret is AES-256-GCM encrypted.

ALTER TABLE nexus_mcp_servers
  ADD COLUMN IF NOT EXISTS oauth_credentials JSONB;

COMMENT ON COLUMN nexus_mcp_servers.oauth_credentials IS
  'Pre-registered OAuth client credentials. clientSecret is AES-256-GCM encrypted via token-encryption module.';
