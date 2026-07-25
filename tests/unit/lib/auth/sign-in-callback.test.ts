import { inAppSignInCallbackUrl } from "@/lib/auth/sign-in-callback"

describe("in-app sign-in callback", () => {
  it("preserves the OAuth interaction uid query parameter", () => {
    expect(
      inAppSignInCallbackUrl({
        pathname: "/oauth/authorize",
        search: "?uid=interaction-123",
      })
    ).toBe("/oauth/authorize?uid=interaction-123")
  })

  it("does not add a query delimiter when there is no search", () => {
    expect(
      inAppSignInCallbackUrl({
        pathname: "/dashboard",
        search: "",
      })
    ).toBe("/dashboard")
  })
})
