"use server"

/**
 * Server action wrapper over `publicBlockers` — "will this object's public link
 * actually load for someone outside the district?".
 *
 * The rule itself lives in `lib/content/public-reachability.ts` (see its header
 * for why it exists and the mirroring requirement against the public route).
 * This layer only resolves the object — through `contentService.get`, which
 * enforces `canView` and 404s anything the caller cannot already see — and its
 * live publications.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError } from "@/lib/error-utils";
import { contentService } from "@/lib/content";
import { publishService } from "@/lib/content/publish-service";
import {
  publicBlockers,
  type PublicBlocker,
} from "@/lib/content/public-reachability";
import type { ActionState } from "@/types";
import { getOptionalRequester } from "./requester";

export interface PublicReachability {
  objectId: string;
  /** True only when every condition the public route checks is satisfied. */
  reachable: boolean;
  /** Every unmet condition, so the UI can explain all of them at once. */
  blockers: PublicBlocker[];
}

export async function publicReachabilityAction(
  idOrSlug: string
): Promise<ActionState<PublicReachability>> {
  const requestId = generateRequestId();
  const timer = startTimer("publicReachabilityAction");
  const log = createLogger({ requestId, action: "publicReachabilityAction" });

  try {
    // Enforces canView and masks a non-viewable/absent object as NotFound.
    const requester = await getOptionalRequester(requestId);
    const obj = await contentService.get(requester, idOrSlug);

    const publications = await publishService.listLive(requester, obj.id);
    const blockers = await publicBlockers({
      hasLivePublicWebPublication: publications.some(
        (p) => p.destination === "public_web"
      ),
      visibilityLevel: obj.visibilityLevel,
      collectionId: obj.collectionId,
    });

    timer({ status: "success" });
    log.info("Public reachability evaluated", {
      objectId: obj.id,
      blockers,
    });
    return createSuccess(
      { objectId: obj.id, reachable: blockers.length === 0, blockers },
      "Public reachability evaluated"
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to check the public link", {
      context: "publicReachabilityAction",
      requestId,
      operation: "publicReachabilityAction",
    });
  }
}
