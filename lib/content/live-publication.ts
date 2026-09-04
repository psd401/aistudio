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
 */

import { and, eq, inArray, type SQL } from "drizzle-orm";
import { contentPublications } from "@/lib/db/schema";
import {
  LIVE_SURFACE_DESTINATIONS,
  type PublishDestination,
} from "./publish-adapters/types";

/**
 * Drizzle condition: this `content_publications` row is the object's LIVE row.
 *
 * Combine with an `objectId` (or join) predicate at the call site — this covers
 * only the destination + status half, which is the half that was duplicated.
 */
export function isLivePublicationRow(): SQL | undefined {
  return and(
    inArray(
      contentPublications.destination,
      LIVE_SURFACE_DESTINATIONS as PublishDestination[]
    ),
    eq(contentPublications.status, "live")
  );
}

/**
 * Whether a set of live destinations (as returned by `publishService.listLive`)
 * means the object is Live. Used by the authoring surfaces, which read
 * publications through the action rather than the DB.
 */
export function isLive(destinations: Iterable<string>): boolean {
  const live = new Set<string>(LIVE_SURFACE_DESTINATIONS);
  for (const destination of destinations) {
    if (live.has(destination)) return true;
  }
  return false;
}
