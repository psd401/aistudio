/**
 * OAuth Issuer URL Configuration
 * Single source of truth for resolving the OIDC issuer URL.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

/**
 * Get the OAuth/OIDC issuer URL from environment.
 * AUTH_URL is the NextAuth v5 canonical variable and takes precedence.
 * NEXTAUTH_URL is the legacy v4 name and is checked as a fallback only.
 */
export function getIssuerUrl(override?: string): string {
  return (
    override ??
    process.env.AUTH_URL ??
    process.env.NEXTAUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  )
}
