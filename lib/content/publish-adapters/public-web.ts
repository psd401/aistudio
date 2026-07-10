/**
 * Atrium public-web publish adapter (reader-backed, anonymous)
 *
 * Issue #1057 (Epic #1059, Atrium Phase 7, spec §15.2 / §20 / §26.4). The
 * `public_web` destination makes a version live at an ANONYMOUS reader route
 * (`app/(public)/p/[slug]/page.tsx`) — the world-readable twin of the internal
 * `/c/[slug]` reader. Like the intranet adapter it has **no external system to
 * call**: the public reader is a React Server Component that reads
 * `content_publications` directly to resolve the live version, then renders the
 * SAME sanitized markdown (documents) or the SAME cross-origin artifact sandbox
 * (artifacts) as the internal reader. "Publishing to public_web" therefore only
 * writes/refreshes the canonical `content_publications` row (the publish
 * service's job); this adapter's single job is to compute the public URL that
 * row's `external_ref` records.
 *
 * ## §33 #7 — resolved: authenticated-but-anonymous Next route (not CloudFront/S3)
 * The spec left open whether `public_web` is served by a CloudFront + S3 static
 * export or by an authenticated-but-anonymous Next public route. Phase 7 resolves
 * it to the Next route: it reuses the existing render pipeline + artifact sandbox
 * unchanged, needs no net-new CDK/CloudFront distribution, and satisfies the
 * acceptance criteria (a public object renders at an anonymous route; a non-public
 * one does not) with the same permission boundary the rest of the content layer
 * enforces. A static-export CDN remains a future optimization behind the same
 * `ATRIUM_PUBLIC_BASE_URL` (only the adapter body would change — the reader route
 * and `external_ref` contract stay identical).
 *
 * ## Governance
 * `public_web` is a PUBLIC destination (`isPublicDestination` → true), so the
 * publish service routes an unauthorized caller — including EVERY autonomous
 * agent — through the §26.4 approval gate BEFORE this adapter is ever reached. By
 * the time `publish` runs here the caller has already been authorized.
 *
 * Because the reader gates strictly on a LIVE `public_web` publication AND
 * `visibility_level = 'public'`, there is no external route to tear down on
 * unpublish: flipping the publication row to `unpublished` (the publish service's
 * job) makes the reader 404 immediately. This adapter therefore has no
 * `unpublish` — the optional teardown is genuinely a no-op for a reader-backed
 * destination.
 *
 * See docs/features/atrium-design-spec.md §15.2 / §20 / §26.4 / §33 #7.
 */

import { publicReaderLink } from "../surface-helpers";
import type { PublishAdapter } from "./types";

export const publicWebAdapter: PublishAdapter = {
  destination: "public_web",

  /**
   * Record the object's public reader URL as the publication's `external_ref`.
   * There is no external system to call: the anonymous reader route renders the
   * live version on demand from the same S3 source + sandbox the internal reader
   * uses. Returns the `${ATRIUM_PUBLIC_BASE_URL}/p/{slug}` URL so a client can
   * link straight to the public page (when the base is unset it degrades to a
   * relative `/p/{slug}` path, still a valid same-origin link).
   */
  async publish({ slug }): Promise<{ externalRef: string | null }> {
    return { externalRef: publicReaderLink(slug) };
  },
};
