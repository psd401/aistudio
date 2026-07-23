/**
 * Atrium intranet publish adapter (reader-backed)
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1) + #1054 (Phase 4, nav wiring). The
 * `intranet` destination has **no external system**: an intranet-published object
 * is served by the in-app reader at `/c/[slug]` (a React Server Component) which
 * reads `content_publications` directly to resolve the live version. "Publishing
 * to intranet" therefore writes/refreshes the canonical `content_publications`
 * row (the publish service's job) and, as of Phase 4, surfaces the object in the
 * intranet IA by ensuring a `content` navigation item points at it.
 *
 * Because there is no external resource, `externalRef` stays `null` for the
 * intranet destination (the reader addresses the object by its slug, not by an
 * external id).
 *
 * The nav-item write runs here (in the adapter, AFTER the publish transaction
 * commits) rather than inside the publish transaction: it is a side effect on a
 * different table that must not roll the canonical publication row back if it
 * fails, mirroring the drizzle-client "no external/secondary IO inside a tx"
 * guidance. The publish service compensates a thrown adapter by marking the
 * publication `failed`.
 *
 * See docs/features/atrium-design-spec.md §15.2 / §21.
 */

import { navItemService } from "../nav-item-service";
import type { PublishAdapter } from "./types";

export const intranetAdapter: PublishAdapter = {
  destination: "intranet",

  /**
   * Ensure a `content` nav item points at the published object so it appears in
   * the intranet IA (under its collection's section when the collection has a nav
   * item). Idempotent on republish. The reader route renders the live version;
   * there is no external system to call and no identifier to return.
   */
  async publish({ objectId, slug, title, collectionId }): Promise<{
    externalRef: string | null;
  }> {
    await navItemService.ensureNavItem({
      id: objectId,
      title,
      slug,
      collectionId,
    });
    return { externalRef: null };
  },

  /**
   * Hide the object's content nav item on unpublish (soft `is_active=false`, so a
   * later republish re-activates the same row). There is no external teardown.
   */
  async unpublish({ objectId }): Promise<void> {
    await navItemService.hideNavItem(objectId);
  },
};
