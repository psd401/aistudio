/**
 * OAuth Issuer URL Configuration
 * Single source of truth for resolving the OIDC issuer URL.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

/**
 * Get the OAuth/OIDC issuer URL from environment.
 * Checks NEXTAUTH_URL, NEXT_PUBLIC_APP_URL, falls back to localhost.
 */
export function getIssuerUrl(override?: string): string {
  return (
    override ??
    process.env.NEXTAUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  )
}
