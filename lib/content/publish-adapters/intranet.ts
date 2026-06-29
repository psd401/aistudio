/**
 * Atrium intranet publish adapter (reader-backed, no-op)
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). The `intranet` destination has **no
 * external system**: an intranet-published object is served by the in-app reader
 * at `/c/[slug]` (a React Server Component) which reads `content_publications`
 * directly to resolve the live version. "Publishing to intranet" therefore means
 * nothing more than the publish service writing/refreshing the canonical
 * `content_publications` row — there is no remote resource to create, so this
 * adapter's `publish` is a no-op.
 *
 * Because there is no external resource, `externalRef` stays `null` for the
 * intranet destination (the reader addresses the object by its slug, not by an
 * external id). For the same reason this adapter has no `unpublish`: unpublishing
 * is a status/row change the publish service owns, not an external teardown.
 *
 * See docs/features/atrium-design-spec.md §15 (publishing).
 */

import type { PublishAdapter } from "./types";

export const intranetAdapter: PublishAdapter = {
  destination: "intranet",

  /**
   * No-op: the intranet reader reads `content_publications` directly, so making a
   * version "live" is fully accomplished by the publish service upserting the
   * row. There is no external system to call and no identifier to return.
   */
  async publish(): Promise<{ externalRef: string | null }> {
    return { externalRef: null };
  },
};
