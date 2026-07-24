/**
 * Unit tests for lib/oauth/oauth-scopes.ts — REV-COR-637.
 *
 * getScopeLabel must use own-property semantics, not `in`, so a client/consent-supplied
 * scope naming an inherited Object.prototype member ("constructor"/"toString"/"__proto__")
 * returns the raw-string fallback rather than a Function or other inherited value.
 */

import {
  getScopeLabel,
  PUBLIC_CLIENT_REQUIRED_OIDC_SCOPES,
  withPublicClientRequiredScopes,
} from "@/lib/oauth/oauth-scopes"

describe("getScopeLabel (REV-COR-637)", () => {
  it("returns the OIDC label for a known OIDC scope", () => {
    expect(getScopeLabel("openid")).toBe("Verify your identity")
  })

  it("returns the API_SCOPES label for a known MCP scope", () => {
    expect(getScopeLabel("mcp:search_decisions")).toBe(
      "Search decision graph nodes via MCP"
    )
  })

  it("falls back to the raw string for an unknown scope", () => {
    expect(getScopeLabel("totally:unknown")).toBe("totally:unknown")
  })

  it.each([
    "constructor",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
    "__proto__",
    "prototype",
  ])("returns the raw string (never an inherited member) for %p", (scope) => {
    const label = getScopeLabel(scope)
    expect(typeof label).toBe("string")
    expect(label).toBe(scope)
  })
})

describe("withPublicClientRequiredScopes", () => {
  it("adds the OIDC baseline required by public authorization-code clients", () => {
    expect(withPublicClientRequiredScopes(["content:read"])).toEqual([
      "openid",
      "profile",
      "offline_access",
      "content:read",
    ])
  })

  it("preserves caller scopes without duplicating required scopes", () => {
    const scopes = withPublicClientRequiredScopes([
      "profile",
      "content:create",
      "openid",
      "content:create",
    ])

    expect(scopes).toEqual([
      ...PUBLIC_CLIENT_REQUIRED_OIDC_SCOPES,
      "content:create",
    ])
  })
})
