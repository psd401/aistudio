/**
 * Publish-destination audience reconciliation (#1336 C2).
 *
 * Visibility and publication are two INDEPENDENT switches, and before #1336 no
 * UI tied them together:
 *  - "Make public" flipped `content_objects.visibility_level` and created no
 *    publication, so `/p/{slug}` still 404'd.
 *  - "Publish to web" created the publication and never widened visibility, so
 *    the strict `/p/[slug]` gate (which requires BOTH `visibility_level =
 *    'public'` AND a live `public_web` row) 404'd for everyone — a Private doc
 *    could reach a cheerful "Published to intranet" with a dead link.
 *
 * This module answers one question: does publishing to `destination` need the
 * object's visibility widened first, and to what? The widen itself is executed
 * through `publishDocumentAction`'s EXISTING `visibility` parameter, inside the
 * service's existing transaction-gated path — no new write path.
 */

import type { VisibilityLevel } from "@/lib/content";
import { reachesAtLeast } from "@/lib/content/audience-rank";
import type { EditorPublishDestination } from "@/actions/db/atrium/publish-document";

/**
 * The minimum visibility a destination's readers need.
 *
 * - `public_web` serves `/p/{slug}` to ANONYMOUS readers, which requires
 *   `public`.
 * - `intranet` serves `/c/{slug}` to any signed-in user, which requires
 *   `internal` — a Private or group-scoped doc published to the intranet is
 *   readable only by its owner/grantees, so the "published" state is a lie for
 *   everyone else.
 * - The connector stubs publish nowhere yet and require nothing.
 */
export function requiredVisibilityFor(
  destination: EditorPublishDestination
): VisibilityLevel | null {
  switch (destination) {
    case "public_web":
      return "public";
    case "intranet":
      return "internal";
    default:
      return null;
  }
}

/**
 * The widen this publish needs, or `null` when the object's current visibility
 * already reaches the destination's audience (including when it EXCEEDS it — a
 * public doc published to the intranet needs no change and must never be
 * narrowed).
 */
export function widenNeededFor(
  destination: EditorPublishDestination,
  current: VisibilityLevel
): VisibilityLevel | null {
  const required = requiredVisibilityFor(destination);
  if (!required) return null;
  return reachesAtLeast(current, required) ? null : required;
}

/** Human-readable label for a visibility level, for confirm/warning copy. */
export const VISIBILITY_LABELS: Record<VisibilityLevel, string> = {
  private: "Private",
  group: "Shared with specific people",
  internal: "Everyone signed in",
  public: "Public",
};
