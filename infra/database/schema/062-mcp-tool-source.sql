-- Migration 062: Add tool_source column to nexus_mcp_servers
-- Supports custom tool providers (e.g., Canva Connect API) alongside MCP server tools.
-- When tool_source = 'custom', getConnectorTools() returns built-in tool definitions
-- instead of fetching from an MCP server.

ALTER TABLE nexus_mcp_servers
  ADD COLUMN IF NOT EXISTS tool_source VARCHAR(50) DEFAULT 'mcp';

COMMENT ON COLUMN nexus_mcp_servers.tool_source IS
  'How tools are provided: mcp (fetch from server), custom (built-in tool definitions)';
