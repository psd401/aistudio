"use client";

/**
 * The per-user star on a library card (migration 175).
 *
 * Rendered as a SIBLING of the card's `<Link>`, never a descendant — the same
 * rule the selection checkbox follows: an interactive control inside an anchor
 * is invalid HTML and every click would also navigate.
 *
 * Optimistic: the star flips immediately and reverts if the write fails, because
 * a bookmark toggle that waits on a round-trip feels broken. A failure is
 * deliberately quiet (the star simply returns to its prior state) — a toast for
 * a failed bookmark would be louder than the action deserves — but it IS logged.
 */

import { useCallback, useState } from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { toggleFavoriteAction } from "@/actions/db/atrium/toggle-favorite";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "FavoriteStar" });

export interface FavoriteStarProps {
  objectId: string;
  title: string;
  /** Server-rendered state from the list projection (`ContentObjectDTO.isFavorite`). */
  initial: boolean;
  /** Notifies the parent so a Favorites band can drop the card without a refetch. */
  onChange?: (objectId: string, isFavorite: boolean) => void;
}

export function FavoriteStar({
  objectId,
  title,
  initial,
  onChange,
}: FavoriteStarProps): React.JSX.Element {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);

  const toggle = useCallback(async () => {
    if (busy) return;
    const next = !on;
    setOn(next);
    setBusy(true);
    try {
      const res = await toggleFavoriteAction(objectId, next);
      if (res.isSuccess) {
        // Trust the server's answer over the optimistic guess — a double click
        // racing two writes should land on whatever actually persisted.
        setOn(res.data.isFavorite);
        onChange?.(objectId, res.data.isFavorite);
      } else {
        setOn(!next);
        log.warn("toggleFavoriteAction failed", { objectId, message: res.message });
      }
    } catch (e) {
      setOn(!next);
      log.error("toggleFavoriteAction threw", {
        objectId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    setBusy(false);
  }, [busy, on, objectId, onChange]);

  return (
    <button
      type="button"
      className={cn("mer-lib-card-star", on && "mer-lib-card-star--on")}
      // The accessible name states the ACTION, not the state: a screen-reader
      // user activating this needs to know what will happen.
      aria-label={on ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
      aria-pressed={on}
      // The optimistic flip lands before the write does, so `aria-pressed` alone
      // cannot tell a caller (or a test) that the change is DURABLE. This does.
      data-busy={busy ? "true" : "false"}
      data-testid={`favorite-${objectId}`}
      onClick={(e) => {
        // The card behind this is a link; without both of these a click would
        // toggle AND navigate.
        e.preventDefault();
        e.stopPropagation();
        void toggle();
      }}
    >
      <Star
        className="h-4 w-4"
        aria-hidden="true"
        // Filled only when on — an outline star reads as "not saved" at a glance.
        fill={on ? "currentColor" : "none"}
      />
    </button>
  );
}

export default FavoriteStar;
