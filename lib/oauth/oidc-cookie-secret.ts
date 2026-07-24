/**
 * Resolve the cookie encryption/signing secret used by oidc-provider.
 *
 * Production deployments require a dedicated key so a compromise of the
 * NextAuth session key cannot also forge or decrypt OIDC provider cookies.
 * FrontendStackEcs provisions and injects this value as OIDC_COOKIE_SECRET.
 *
 * Local development may reuse the legacy NEXTAUTH_SECRET or the canonical
 * NextAuth v5 AUTH_SECRET to avoid requiring another generated secret. Preserve
 * the legacy variable's precedence so existing local OIDC cookies remain valid
 * when both variables are configured.
 */
export function getOidcCookieSecret(): string {
  const dedicatedSecret = process.env.OIDC_COOKIE_SECRET
  if (dedicatedSecret) {
    return dedicatedSecret
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "OIDC_COOKIE_SECRET must be set in production. " +
        "Deploy FrontendStackEcs or generate one with: openssl rand -base64 32"
    )
  }

  return (
    process.env.NEXTAUTH_SECRET ??
    process.env.AUTH_SECRET ??
    "dev-oidc-cookie-secret-change-in-production"
  )
}
