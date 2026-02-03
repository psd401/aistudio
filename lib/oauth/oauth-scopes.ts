/**
 * OAuth Scope Configuration
 * Single source of truth for all OAuth/OIDC scopes.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 *
 * Combines standard OIDC scopes with MCP scopes from API_SCOPES.
 */

import { API_SCOPES } from "@/lib/api-keys/scopes"

// ============================================
// Standard OIDC Scopes
// ============================================

const OIDC_SCOPE_LABELS: Record<string, string> = {
  openid: "Verify your identity",
  profile: "Access your profile information",
  email: "Access your email address",
  offline_access: "Stay connected (refresh tokens)",
}

export const OIDC_SCOPES = Object.keys(OIDC_SCOPE_LABELS)

// ============================================
// Combined Scopes (OIDC + MCP)
// ============================================

const MCP_SCOPES = Object.keys(API_SCOPES).filter((s) => s.startsWith("mcp:"))

/** All scopes the OAuth provider supports (standard OIDC + MCP) */
export const ALL_OAUTH_SCOPES = [...OIDC_SCOPES, ...MCP_SCOPES]

/**
 * Get a human-readable label for a scope.
 * Falls back to the raw scope string if no label is found.
 */
export function getScopeLabel(scope: string): string {
  if (scope in OIDC_SCOPE_LABELS) {
    return OIDC_SCOPE_LABELS[scope]
  }
  if (scope in API_SCOPES) {
    return API_SCOPES[scope as keyof typeof API_SCOPES]
  }
  return scope
}
