/**
 * Error category identifiers for MCP OAuth error classification.
 * Routes map these stable categories to their own user-facing messages.
 */
export type McpOAuthErrorCategory =
  | "timeout"
  | "connectivity"
  | "unauthorized"
  | "forbidden"
  | "invalid_token"
  | "discovery"
  | "registration"
  | "pkce"
  | "encryption"
  | "blocked"
  | "not_found"
  | "unexpected"

interface McpOAuthErrorRule {
  category: Exclude<McpOAuthErrorCategory, "unexpected">
  matches: (message: string) => boolean
}

/**
 * String patterns are evaluated in order. HTTP status checks intentionally
 * precede the generic invalid-token rule, so "401: invalid token" remains the
 * more actionable "unauthorized" category.
 */
const MCP_OAUTH_ERROR_RULES: readonly McpOAuthErrorRule[] = [
  {
    category: "timeout",
    matches: (message) =>
      message.includes("timeout")
      || message.includes("timed out")
      || message.includes("aborted"),
  },
  {
    category: "connectivity",
    matches: (message) =>
      message.includes("fetch failed")
      || message.includes("econnrefused")
      || message.includes("enotfound"),
  },
  {
    category: "unauthorized",
    matches: (message) =>
      /\b401\b/.test(message) || message.includes("unauthorized"),
  },
  {
    category: "forbidden",
    matches: (message) =>
      /\b403\b/.test(message) || message.includes("forbidden"),
  },
  {
    category: "invalid_token",
    matches: (message) =>
      message.includes("invalid") && message.includes("token"),
  },
  {
    category: "discovery",
    matches: (message) =>
      message.includes("metadata")
      || message.includes("well-known")
      || message.includes("discovery"),
  },
  {
    category: "registration",
    matches: (message) =>
      message.includes("client registration")
      || message.includes("dynamic registration"),
  },
  {
    category: "pkce",
    matches: (message) =>
      message.includes("code verifier") || message.includes("pkce"),
  },
  {
    category: "encryption",
    matches: (message) =>
      message.includes("decrypt") || message.includes("encrypt"),
  },
  {
    category: "blocked",
    matches: (message) =>
      message.includes("ssrf")
      || message.includes("private network")
      || message.includes("internal address"),
  },
  {
    category: "not_found",
    matches: (message) => message.includes("mcp server not found"),
  },
]

export function classifyMcpOAuthError(message: string): McpOAuthErrorCategory {
  const lower = message.toLowerCase()
  return MCP_OAUTH_ERROR_RULES.find((rule) => rule.matches(lower))?.category
    ?? "unexpected"
}
