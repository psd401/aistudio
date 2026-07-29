/**
 * Explicit browser-origin policy for public OAuth clients.
 *
 * Browser origins are independent registration data. In particular, a redirect
 * URI is not evidence that JavaScript from a similarly named origin is trusted.
 * Keep this allowlist exact and deliberately small.
 */

export const ATRIUM_CAPTURE_BROWSER_CLIENT_ID =
  "ae781263-20c0-4b0c-8a34-8be01ab72fb1"

export const ATRIUM_CAPTURE_EXTENSION_ORIGIN =
  "chrome-extension://eomlblaiglafndhplfhilmdcaofhkkbj"

const ATRIUM_CAPTURE_TOKEN_GRANTS = new Set([
  "authorization_code",
  "refresh_token",
])

interface OAuthClientOriginRequest {
  clientId: string
  origin: string
  route: string
  grantType?: unknown
}

/**
 * Allow only the production Atrium Capture extension on the endpoints it must
 * call. Matching is byte-for-byte: no wildcard, normalization, suffix matching,
 * or redirect-URI inference.
 */
export function isAllowedOAuthClientOrigin(
  request: OAuthClientOriginRequest
): boolean {
  if (
    request.clientId !== ATRIUM_CAPTURE_BROWSER_CLIENT_ID ||
    request.origin !== ATRIUM_CAPTURE_EXTENSION_ORIGIN
  ) {
    return false
  }

  if (request.route === "revocation") return true
  return (
    request.route === "token" &&
    typeof request.grantType === "string" &&
    ATRIUM_CAPTURE_TOKEN_GRANTS.has(request.grantType)
  )
}
