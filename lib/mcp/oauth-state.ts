/**
 * Builds a per-server cookie name for encrypted MCP OAuth PKCE state.
 *
 * This lives outside the route module because Next route files may only export
 * supported HTTP handlers and route configuration fields.
 */
export function getOAuthStateCookieName(serverId: string): string {
  // Full UUID avoids collisions when only later segments differ.
  // Dashes are valid in cookie names per RFC 6265.
  return `mcp_oauth_state_${serverId}`
}
