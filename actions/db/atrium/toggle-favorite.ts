"use server"

/**
 * Atrium toggle-favorite server action.
 *
 * Stars/unstars a content object for the CALLING user (`content_user_favorites`,
 * migration 175) — the write behind the Favorites band on the library home.
 *
 * SECURITY: the object is resolved through `contentService.get`, which enforces
 * the same `canView` gate as every other read and 404s an object the caller
 * cannot see. That is deliberate and load-bearing: without it, posting arbitrary
 * uuids here would distinguish "object exists" (success) from "no such object"
 * (FK violation) and become an existence oracle. Routed through `get`, both are
 * an identical NotFound.
 *
 * This is NOT capability-gated, matching `listContentAction`: favoriting is a
 * personal bookmark on content the caller can already see, not an authoring
 * action. It confers no access — see `lib/content/favorites-service.ts`.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { contentService } from "@/lib/content";
import { favoritesService } from "@/lib/content/favorites-service";
import type { ActionState } from "@/types";
import { getOptionalRequester } from "./requester";

export async function toggleFavoriteAction(
  idOrSlug: string,
  favorite: boolean
): Promise<ActionState<{ objectId: string; isFavorite: boolean }>> {
  const requestId = generateRequestId();
  const timer = startTimer("toggleFavoriteAction");
  const log = createLogger({ requestId, action: "toggleFavoriteAction" });

  try {
    log.info("Action started: toggle favorite", { idOrSlug, favorite });

    const requester = await getOptionalRequester(requestId);
    if (requester.kind !== "user") {
      // Guests and agents have no personal library. Surfaced as an auth error
      // (not a validation error) so the client can prompt a sign-in.
      throw ErrorFactories.authNoSession();
    }

    // Enforces canView and masks a non-viewable/absent object as NotFound.
    const obj = await contentService.get(requester, idOrSlug);
    const isFavorite = await favoritesService.set(requester, obj.id, favorite);

    timer({ status: "success" });
    log.info("Favorite toggled", { objectId: obj.id, isFavorite });
    return createSuccess(
      { objectId: obj.id, isFavorite },
      isFavorite ? "Added to favorites" : "Removed from favorites"
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to update favorites", {
      context: "toggleFavoriteAction",
      requestId,
      operation: "toggleFavoriteAction",
    });
  }
}
