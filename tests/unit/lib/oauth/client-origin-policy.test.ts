import {
  ATRIUM_CAPTURE_BROWSER_CLIENT_ID,
  ATRIUM_CAPTURE_EXTENSION_ORIGIN,
  isAllowedOAuthClientOrigin,
} from "@/lib/oauth/client-origin-policy"

describe("OAuth client browser-origin policy", () => {
  it.each(["authorization_code", "refresh_token"])(
    "allows the exact extension origin for the %s token grant",
    (grantType) => {
      expect(
        isAllowedOAuthClientOrigin({
          clientId: ATRIUM_CAPTURE_BROWSER_CLIENT_ID,
          origin: ATRIUM_CAPTURE_EXTENSION_ORIGIN,
          route: "token",
          grantType,
        })
      ).toBe(true)
    }
  )

  it("allows the exact extension origin on revocation", () => {
    expect(
      isAllowedOAuthClientOrigin({
        clientId: ATRIUM_CAPTURE_BROWSER_CLIENT_ID,
        origin: ATRIUM_CAPTURE_EXTENSION_ORIGIN,
        route: "revocation",
      })
    ).toBe(true)
  })

  it.each([
    {
      name: "different client",
      clientId: "different-client",
      origin: ATRIUM_CAPTURE_EXTENSION_ORIGIN,
      route: "token",
      grantType: "authorization_code",
    },
    {
      name: "different extension",
      clientId: ATRIUM_CAPTURE_BROWSER_CLIENT_ID,
      origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      route: "token",
      grantType: "authorization_code",
    },
    {
      name: "retired extension",
      clientId: ATRIUM_CAPTURE_BROWSER_CLIENT_ID,
      origin: "chrome-extension://jldnpmcpimhabiphcglkbgmbffpoocpo",
      route: "token",
      grantType: "authorization_code",
    },
    {
      name: "origin suffix",
      clientId: ATRIUM_CAPTURE_BROWSER_CLIENT_ID,
      origin: `${ATRIUM_CAPTURE_EXTENSION_ORIGIN}.example`,
      route: "token",
      grantType: "authorization_code",
    },
    {
      name: "redirect origin",
      clientId: ATRIUM_CAPTURE_BROWSER_CLIENT_ID,
      origin: "https://eomlblaiglafndhplfhilmdcaofhkkbj.chromiumapp.org",
      route: "token",
      grantType: "authorization_code",
    },
    {
      name: "other endpoint",
      clientId: ATRIUM_CAPTURE_BROWSER_CLIENT_ID,
      origin: ATRIUM_CAPTURE_EXTENSION_ORIGIN,
      route: "userinfo",
      grantType: "authorization_code",
    },
    {
      name: "other grant",
      clientId: ATRIUM_CAPTURE_BROWSER_CLIENT_ID,
      origin: ATRIUM_CAPTURE_EXTENSION_ORIGIN,
      route: "token",
      grantType: "client_credentials",
    },
  ])("denies $name", (request) => {
    expect(isAllowedOAuthClientOrigin(request)).toBe(false)
  })
})
