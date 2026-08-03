/**
 * Favorites service — the per-user star on a content object (migration 175).
 *
 * ## Why this is not a visibility rule
 *
 * A favorite grants NOTHING. It is a personal bookmark that narrows what the
 * library home leads with; every read that joins through
 * `content_user_favorites` still passes the object through the normal
 * `canView` gate (see `visibilityService.listVisible`, where the favorite
 * filter is an additive AND on top of `buildVisibilitySql`). So an object that
 * someone starred and that later became invisible to them simply stops
 * appearing — the star row is inert, not a back door.
 *
 * ## Why setting a favorite still checks visibility
 *
 * `set()` resolves the object through `contentService.get`, which enforces
 * `canView` and 404s an object the caller cannot see. Without that, POSTing
 * arbitrary uuids would turn this into an existence oracle: a FK violation
 * ("no such object") and a success ("object exists") are distinguishable
 * responses. Routing through `get` makes both cases indistinguishable — a
 * NotFound either way.
 */

import { eq, and, sql } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentUserFavorites } from "@/lib/db/schema";
import type { Requester } from "./types";
import { ValidationError } from "./errors";

/** The user id a favorite is recorded against, or null for a non-user caller. */
function favoriteUserId(req: Requester): number | null {
  return req.kind === "user" && req.userId != null ? req.userId : null;
}

export const favoritesService = {
  /**
   * Add or remove the caller's star on an object. Idempotent in both directions:
   * starring twice leaves one row, unstarring an unstarred object is a no-op.
   * Returns the resulting state so a caller can render without a re-read.
   *
   * The caller MUST have already established that `objectId` is viewable — the
   * server action does this via `contentService.get`. This method does not
   * re-check, because it has no requester context beyond the user id.
   */
  async set(req: Requester, objectId: string, favorite: boolean): Promise<boolean> {
    const userId = favoriteUserId(req);
    if (userId == null) {
      // Agents and guests have no personal library. This is a caller bug rather
      // than an authorization failure — the UI never offers the control.
      throw new ValidationError("Only a signed-in user can favorite content", {
        objectId,
      });
    }

    if (favorite) {
      await executeQuery(
        (db) =>
          db
            .insert(contentUserFavorites)
            .values({ userId, objectId })
            // Re-starring is a no-op, not a unique violation. Keeps the original
            // created_at, so "recently favorited" ordering is not reset by a
            // double click.
            .onConflictDoNothing(),
        "content.favorite.add"
      );
      return true;
    }

    await executeQuery(
      (db) =>
        db
          .delete(contentUserFavorites)
          .where(
            and(
              eq(contentUserFavorites.userId, userId),
              eq(contentUserFavorites.objectId, objectId)
            )
          ),
      "content.favorite.remove"
    );
    return false;
  },

  /**
   * How many objects the caller has starred. Used to decide whether the library
   * home shows a Favorites band at all — an empty band is worse than none.
   * Counts rows, NOT visible rows: it is a cheap hint, and the band itself
   * re-reads through the visibility gate.
   */
  async count(req: Requester): Promise<number> {
    const userId = favoriteUserId(req);
    if (userId == null) return 0;

    const rows = await executeQuery(
      (db) =>
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(contentUserFavorites)
          .where(eq(contentUserFavorites.userId, userId)),
      "content.favorite.count"
    );
    return rows[0]?.n ?? 0;
  },
};
