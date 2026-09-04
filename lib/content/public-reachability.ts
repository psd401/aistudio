/**
 * Is an object's PUBLIC link actually reachable?
 *
 * ## Why this exists
 *
 * The public page is DERIVED (#1726): `/p/[slug]` renders when an object is
 * `public` AND Live. `app/(public)/p/[slug]/page.tsx` gates that route on THREE
 * independent conditions, and being Live is only one of them. A Live object
 * whose Level is still `internal`, or one sitting in a section anonymous
 * visitors cannot enter, gets a Live badge and a copyable URL — and a 404 for
 * everyone who follows it. The failure is silent to the author, who has every
 * visible signal telling them it worked.
 *
 * This computes the same decision the public route makes and NAMES the blockers
 * so authoring surfaces can say which condition is unmet.
 *
 * ## Mirroring requirement
 *
 * These conditions MUST stay equivalent to `loadPublicObject` in
 * `app/(public)/p/[slug]/page.tsx`. They are one rule expressed twice — a gate
 * there, an explanation here — and drift means telling an author their link
 * works when it does not. Change the public gate, change this in the same
 * commit.
 *
 * ADVISORY ONLY: nothing here authorizes anything. Callers must already have
 * cleared the object through `canView`.
 */

import { requesterMayViewCollection } from "./collection-access";
import type { Requester, VisibilityLevel } from "./types";

/**
 * The anonymous principal the public route evaluates against. MUST match
 * `ANONYMOUS_REQUESTER` in `app/(public)/p/[slug]/page.tsx` — a requester
 * carrying a user id or a role would pass collection checks a real visitor
 * fails, which is precisely the bug this exists to catch.
 */
export const ANONYMOUS_REQUESTER: Requester = {
  kind: "user",
  userId: null,
  roles: [],
  groups: [],
  isAdmin: false,
};

export type PublicBlocker =
  /** The object is a Draft — never published, or taken back down. */
  | "not_published"
  /** `visibility_level` is not `public`; the route gates strictly on this. */
  | "not_public"
  /** The object's section is not enterable by an anonymous visitor. */
  | "section_restricted";

/** Human-readable explanation + remedy for each blocker. */
export const PUBLIC_BLOCKER_TEXT: Record<PublicBlocker, string> = {
  not_published:
    "It is still a draft, so the link goes nowhere — switch it to Live.",
  not_public:
    "Its level is not Public, and the public address requires that — set the level to Public.",
  section_restricted:
    "Its section is limited to specific people, and the public page will not show content from a restricted section. Move it to an unrestricted section, or remove the section's view restrictions.",
};

/**
 * Every unmet condition for the public link, in the order a reader would hit
 * them. Empty means the link resolves.
 */
export async function publicBlockers(input: {
  /** The object has a live publication row (`isLive` over its destinations). */
  isLive: boolean;
  visibilityLevel: VisibilityLevel;
  collectionId: string | null;
}): Promise<PublicBlocker[]> {
  const blockers: PublicBlocker[] = [];
  if (!input.isLive) blockers.push("not_published");
  if (input.visibilityLevel !== "public") blockers.push("not_public");
  // Evaluated as the ANONYMOUS visitor, not as the caller: an administrator can
  // enter every section, so asking "can I see it?" would always say yes and
  // never surface the restriction that is actually breaking the link.
  if (!(await requesterMayViewCollection(ANONYMOUS_REQUESTER, input.collectionId))) {
    blockers.push("section_restricted");
  }
  return blockers;
}
