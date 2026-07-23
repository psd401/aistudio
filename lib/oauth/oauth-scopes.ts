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

// Atrium content scopes (Phase 5, Issue #1055) — so autonomous agent OAuth
// clients (client-credentials) can request content:create / publish_internal etc.
const CONTENT_SCOPES = Object.keys(API_SCOPES).filter((s) =>
  s.startsWith("content:")
)

// Platform capability-catalog scope (Issue #1100) — so OAuth/JWT MCP callers
// (incl. the agent authenticating with an OAuth access token) can request
// platform:read and reach the describe_capabilities meta-tool. Without this the
// OIDC provider would neither advertise nor accept platform:read, and every
// OAuth-authenticated tools/call for that tool would fail the scope check.
const PLATFORM_SCOPES = Object.keys(API_SCOPES).filter((s) =>
  s.startsWith("platform:")
)

/**
 * All scopes the OAuth provider supports (standard OIDC + MCP + Atrium content +
 * platform capability catalog).
 */
export const ALL_OAUTH_SCOPES = [
  ...OIDC_SCOPES,
  ...MCP_SCOPES,
  ...CONTENT_SCOPES,
  ...PLATFORM_SCOPES,
]

/**
 * Get a human-readable label for a scope.
 * Falls back to the raw scope string if no label is found.
 */
export function getScopeLabel(scope: string): string {
  // Own-property checks, not `in` (REV-COR-637): `scope` comes from client/consent-supplied
  // scope lists, and `in` walks the prototype chain — so "constructor"/"toString"/"__proto__"
  // would match an inherited Object.prototype member and return a Function (or other non-label
  // value) instead of the intended label or the raw-string fallback.
  if (Object.hasOwn(OIDC_SCOPE_LABELS, scope)) {
    return OIDC_SCOPE_LABELS[scope]
  }
  if (Object.hasOwn(API_SCOPES, scope)) {
    return API_SCOPES[scope as keyof typeof API_SCOPES]
  }
  return scope
}
