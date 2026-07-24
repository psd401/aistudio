import { describe, expect, it } from "@jest/globals"
import {
  oidcApplicationType,
  validateOAuthRedirectUris,
  type OAuthApplicationType,
} from "@/lib/oauth/redirect-uri-policy"

const CHROME_REDIRECT =
  "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/atrium"

function expectValid(
  applicationType: OAuthApplicationType,
  uri: string
): void {
  const result = validateOAuthRedirectUris(applicationType, [uri])
  expect(result).toEqual({
    valid: true,
    normalizedUris: [new URL(uri).href],
    errors: [],
  })
}

function expectInvalid(
  applicationType: OAuthApplicationType,
  uri: string
): void {
  const result = validateOAuthRedirectUris(applicationType, [uri])
  expect(result.valid).toBe(false)
  expect(result.normalizedUris).toEqual([])
  expect(result.errors).toHaveLength(1)
}

describe("OAuth redirect URI policy (#1289)", () => {
  it("accepts hosted HTTPS web callbacks and rejects local or insecure web callbacks", () => {
    expectValid("web", "https://app.example.org/oauth/callback?tenant=psd")
    expectInvalid("web", "http://app.example.org/oauth/callback")
    expectInvalid("web", "https://localhost/oauth/callback")
    expectInvalid("web", "https://127.0.0.1/oauth/callback")
  })

  it("accepts only an exact Chromium extension origin with a fixed path", () => {
    expectValid("browser_extension", CHROME_REDIRECT)
    expectInvalid(
      "browser_extension",
      "https://abcdefghijklmnop.chromiumapp.org/atrium"
    )
    expectInvalid(
      "browser_extension",
      "https://abcdefghijklmnopabcdefghijklmnop.example.org/atrium"
    )
    expectInvalid(
      "browser_extension",
      "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/"
    )
    expectInvalid("browser_extension", `${CHROME_REDIRECT}?next=other`)
  })

  it("accepts native claimed HTTPS and reverse-domain private-use callbacks", () => {
    expectValid("native", "https://mobile.example.org/oauth/callback")
    expectValid("native", "com.example.atrium:/oauth/callback")
  })

  it("accepts IPv4 and IPv6 loopback literals with fixed paths and variable ports", () => {
    expectValid("native", "http://127.0.0.1/oauth/callback")
    expectValid("native", "http://127.0.0.1:49152/oauth/callback")
    expectValid("native", "http://[::1]/oauth/callback")
    expectValid("native", "http://[::1]:49152/oauth/callback")
  })

  it("rejects localhost, non-loopback HTTP, and claimed HTTPS IP addresses", () => {
    expectInvalid("native", "http://localhost/oauth/callback")
    expectInvalid("native", "http://192.168.1.10/oauth/callback")
    expectInvalid("native", "https://192.168.1.10/oauth/callback")
    expectInvalid("native", "https://[::1]/oauth/callback")
    expectInvalid("native", "https://[2001:db8::1]/oauth/callback")
  })

  it("rejects malformed private schemes and non-fixed private callbacks", () => {
    expectInvalid("native", "atrium:/oauth/callback")
    expectInvalid("native", "com.example.atrium://oauth/callback")
    expectInvalid("native", "com.example.atrium:/")
    expectInvalid("native", "com.example.atrium:/oauth/callback?next=other")
  })

  it.each([
    ["native", "file:///oauth/callback"],
    ["native", "javascript:/oauth/callback"],
    ["native", "data:/oauth/callback"],
    ["web", "https://user:password@app.example.org/oauth/callback"],
    ["web", "https://*.example.org/oauth/callback"],
    ["web", "https://app.example.org/oauth/callback#fragment"],
  ] as const)("rejects dangerous %s redirect %s", (applicationType, uri) => {
    expectInvalid(applicationType, uri)
  })

  it("rejects canonical duplicates instead of silently broadening registration", () => {
    const result = validateOAuthRedirectUris("web", [
      "https://app.example.org/oauth/callback",
      "https://app.example.org:443/oauth/callback",
    ])
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain("duplicate")
  })

  it("maps only native applications to the provider's native profile", () => {
    expect(oidcApplicationType("native")).toBe("native")
    expect(oidcApplicationType("browser_extension")).toBe("web")
    expect(oidcApplicationType("web")).toBe("web")
  })
})
