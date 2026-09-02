/**
 * The "What's new" window for the Atrium library.
 *
 * "New" means TOUCHED recently — `content_objects.updated_at` (trigger-backed,
 * so it moves on every write, app or otherwise), which the server's
 * `ListFilter.since` filters on. Publish recency is a different question
 * (`content_publications`), deliberately not this one.
 */

/** How far back "What's new" looks. */
export const WHATS_NEW_DAYS = 7;

/**
 * ISO timestamp for "`days` ago", truncated to the top of the hour.
 *
 * The truncation is load-bearing: this value becomes part of a filter object
 * that React hooks key their fetches on (`useLibraryPage`'s deps,
 * `useBand`'s JSON key). A fresh `Date.now()` on every render would change
 * the filter every render and re-fetch forever; an hourly step keeps it
 * stable across renders while still moving with the clock.
 */
export function recentSince(days: number = WHATS_NEW_DAYS, now: Date = new Date()): string {
  const since = new Date(now.getTime() - days * 86_400_000);
  since.setUTCMinutes(0, 0, 0);
  return since.toISOString();
}
