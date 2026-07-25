/**
 * oidc-provider uses 43-character nanoid values for interaction resume routes.
 * Keep the middleware exception narrower than the surrounding `/auth/*` tree.
 */

const OIDC_RESUME_PATH = /^\/auth\/[A-Za-z0-9_-]{43}$/

export function isOidcProviderResumePath(pathname: string): boolean {
  return OIDC_RESUME_PATH.test(pathname)
}
