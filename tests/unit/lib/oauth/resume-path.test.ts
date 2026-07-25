import { isOidcProviderResumePath } from "@/lib/oauth/resume-path"

describe("OIDC provider resume path", () => {
  it("allows only the provider's exact 43-character URL-safe uid shape", () => {
    expect(
      isOidcProviderResumePath(`/auth/${"a".repeat(43)}`)
    ).toBe(true)
    expect(
      isOidcProviderResumePath(`/auth/${"A_-".repeat(14)}A`)
    ).toBe(true)
  })

  it("does not make the surrounding auth tree public", () => {
    expect(isOidcProviderResumePath("/auth/error")).toBe(false)
    expect(
      isOidcProviderResumePath(`/auth/${"a".repeat(42)}`)
    ).toBe(false)
    expect(
      isOidcProviderResumePath(`/auth/${"a".repeat(44)}`)
    ).toBe(false)
    expect(
      isOidcProviderResumePath(`/auth/${"a".repeat(42)}!`)
    ).toBe(false)
    expect(
      isOidcProviderResumePath(`/auth/${"a".repeat(43)}/extra`)
    ).toBe(false)
  })
})
