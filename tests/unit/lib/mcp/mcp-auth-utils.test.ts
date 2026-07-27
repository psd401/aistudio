import { describe, expect, it } from "@jest/globals"

import {
  classifyMcpOAuthError,
  type McpOAuthErrorCategory,
} from "@/lib/mcp/mcp-oauth-error-classification"

describe("MCP OAuth error classification", () => {
  it.each<[string, McpOAuthErrorCategory]>([
    ["Request timed out", "timeout"],
    ["fetch failed with ECONNREFUSED", "connectivity"],
    ["token endpoint returned 401: invalid token", "unauthorized"],
    ["403 forbidden", "forbidden"],
    ["invalid bearer token", "invalid_token"],
    ["OAuth metadata discovery failed", "discovery"],
    ["dynamic registration unavailable", "registration"],
    ["PKCE code verifier rejected", "pkce"],
    ["unable to decrypt credentials", "encryption"],
    ["SSRF protection blocked a private network", "blocked"],
    ["MCP server not found", "not_found"],
    ["something else happened", "unexpected"],
  ])("classifies %s as %s", (message, category) => {
    expect(classifyMcpOAuthError(message)).toBe(category)
  })
})
