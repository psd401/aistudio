/**
 * Atrium reader-link builders (leaf module — deliberately dependency-free).
 *
 * `contentDeepLink` (internal `/c/{slug}`) and `publicReaderLink` (anonymous
 * `/p/{slug}`) used to live in `surface-helpers.ts`, which also imports
 * `@/utils/roles` and the Drizzle client. Importing them from a service (#1336
 * needed `contentDeepLink` in `publish-service`) therefore dragged the whole
 * capability/DB graph into that module's import chain, which broke unit suites
 * that mock only the service's own dependencies.
 *
 * These two functions read one env var and format a string — nothing else — so
 * they belong in a leaf with no imports at all. `surface-helpers.ts` re-exports
 * them, so every existing import path keeps working.
 */

/** The internal reader deep link for a content object, returned in results. */
export function contentDeepLink(slug: string): string {
  const base = process.env.ATRIUM_PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/c/${slug}`;
}

/**
 * The PUBLIC (anonymous) reader link for a content object at `/p/[slug]` — the
 * `external_ref` the `public_web` publish adapter records and the URL a
 * public-web publication is served at (Phase 7, #1057). Built from
 * `ATRIUM_PUBLIC_BASE_URL` (the same base the internal deep link uses); the
 * §33 #7 decision serves `public_web` via the authenticated-but-anonymous Next
 * public route rather than a separate CloudFront/S3 static export, so the base is
 * the app origin and the path segment (`/p/` vs `/c/`) is the only difference.
 */
export function publicReaderLink(slug: string): string {
  const base = process.env.ATRIUM_PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/p/${slug}`;
}
