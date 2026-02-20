/**
 * Shared utilities for MCP OAuth auth routes.
 *
 * Extracted from route files to avoid cross-route imports (which can interfere
 * with Next.js bundling, route detection, and tree-shaking).
 */

/** UUID v4 format regex */
export const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

/** Returns the cookie name for a per-server OAuth state cookie */
export function getMcpAuthCookieName(serverId: string): string {
  return `mcp_auth_state_${serverId}`
}
