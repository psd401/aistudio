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
 * The authoring-surface link for an object that has no live reader page.
 *
 * Artifacts get the chrome-free full-screen view; documents get the authoring
 * page, which is where their body actually renders. Both are gated purely on
 * `canView`, so an owner reaches their own unpublished content through either.
 */
function atriumSurfaceLink(id: string, kind: "document" | "artifact"): string {
  const base = process.env.ATRIUM_PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/atrium/${id}/${kind === "artifact" ? "view" : "edit"}`;
}

/**
 * The link to hand a caller for a content object — the one that will actually
 * open for someone who can view it.
 *
 * `/c/{slug}` requires a LIVE INTRANET PUBLICATION (see the reader page). For a
 * draft it 404s, and because the reader masks existence it 404s for the OWNER
 * too. Returning it unconditionally therefore handed every API and skill caller
 * a dead link for content that had just been created: psd-morning-brief creates
 * a private artifact and never publishes it, so EVERY morning brief DM linked
 * to a page that 404'd for its own recipient — every user, every day, from the
 * feature's first run until this fix. It surfaced only because one user
 * reported it twice (failures 13503 / 13998, week of 2026-08-21).
 *
 * Published objects keep the canonical reader link; everything else gets the
 * authoring surface, which renders the head version for anyone who can view it.
 *
 * Known mismatch, covered downstream: this keys off `status === "published"`,
 * but the reader requires a live INTRANET publication — an object published
 * only to `public_web`, or whose intranet publication was retracted without a
 * status change, still gets a `/c/` link here. Making this function
 * publication-aware would force a per-object publications query into every
 * list-decorating call site, so instead the reader page itself backstops the
 * gap: `/c/[slug]` redirects a `canView`-passing viewer of an unpublished
 * object to the authoring surface (see `app/(protected)/c/[slug]/page.tsx`).
 * Every `/c/` link this function emits therefore resolves for anyone allowed
 * to see the object.
 */
export function contentSurfaceLink(object: {
  id: string;
  slug: string;
  kind: "document" | "artifact";
  status: "draft" | "published" | "archived";
}): string {
  return object.status === "published"
    ? contentDeepLink(object.slug)
    : atriumSurfaceLink(object.id, object.kind);
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
