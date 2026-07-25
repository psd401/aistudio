/**
 * Preserve the complete in-app destination across authentication.
 *
 * OAuth interaction UIDs live in the query string; dropping `search` abandons
 * the provider interaction after district sign-in.
 */
export function inAppSignInCallbackUrl(url: {
  pathname: string
  search: string
}): string {
  return url.pathname + url.search
}
