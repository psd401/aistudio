/**
 * The single "is this object Live?" predicate (#1726).
 *
 * Atrium used to model publication as a DESTINATION — `intranet` for the signed-in
 * reader, `public_web` for the anonymous one — which made publication a second
 * audience switch competing with the object's visibility Level. Publication is now
 * one Live/Draft STATE recorded as one `content_publications` row, and every
 * audience question is answered by the Level alone. `/p/{slug}` is therefore
 * DERIVED: it resolves when an object is `public` AND Live.
 *
 * Half a dozen surfaces enforce that same conjunction — the public reader, the
 * sitemap, the public asset-bytes gate, the public embed resolver, the
 * reachability diagnostic. They were each hand-writing
 * `destination = 'public_web' AND status = 'live'`; a change to what "Live" means
 * had to land in every one of them or they would start disagreeing about which
 * pages the world can see. This is that one place.
 *
 * `LIVE_SURFACE_DESTINATIONS` (rather than a bare `intranet`) also keeps a
 * pre-#1726 `public_web` row serving its readers until migration 180 folds it in,
 * so the migration and the image deploy can land in either order.
 *
 * SERVER-ONLY (it imports drizzle + the schema). The surfaces that ask the same
 * question of a list of destinations — the Share dialog, the artifact authoring
 * view, the reachability action — use `isLive` from `publish-adapters/types`,
 * which is dependency-free and therefore safe in a client bundle.
 */

import { eq, inArray, type SQL } from "drizzle-orm";
import { contentPublications } from "@/lib/db/schema";
import {
  LIVE_SURFACE_DESTINATIONS,
  type PublishDestination,
} from "./publish-adapters/types";

/**
 * Drizzle conditions: this `content_publications` row is the object's LIVE row.
 * Spread into the call site's `and(...)` alongside its own `objectId` (or join)
 * predicate — this covers only the destination + status half, which is the half
 * that was duplicated.
 *
 * Returns a TUPLE of non-optional `SQL`, deliberately, rather than one pre-`and`ed
 * `SQL | undefined`. Drizzle's `and()` SKIPS undefined operands, so a helper typed
 * `SQL | undefined` can silently contribute nothing to a `where` — and every
 * caller here is a gate on what anonymous visitors may read. A dropped condition
 * would fail OPEN: the public reader would serve any object with any publication
 * row, and the sitemap would advertise them. The tuple makes that unrepresentable.
 */
export function livePublicationConditions(): readonly [SQL, SQL] {
  return [
    inArray(
      contentPublications.destination,
      LIVE_SURFACE_DESTINATIONS as PublishDestination[]
    ),
    eq(contentPublications.status, "live"),
  ];
}
