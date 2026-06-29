"use server"

/**
 * Atrium get-visibility server action
 *
 * Issue #1053 (Epic #1059, Atrium Phase 3). Loads an object's current visibility
 * level + group grants so the visibility editor (VisibilityChip) can populate
 * its level picker and grant builder. Read-gated by `canView` (mask existence →
 * NotFound) — a caller who cannot view the object cannot enumerate its grants.
 *
 * See docs/features/atrium-design-spec.md §12.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError } from "@/lib/error-utils";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { canEdit } from "@/lib/content/helpers";
import { NotFoundError } from "@/lib/content/errors";
import type { VisibilityGrant, VisibilityLevel } from "@/lib/content/types";
import type { ActionState } from "@/types";
import { getOptionalRequester } from "./requester";

export interface VisibilityState {
  visibilityLevel: VisibilityLevel;
  grants: VisibilityGrant[];
  /** Whether the current requester may change the visibility (owner/admin). */
  canEdit: boolean;
}

export async function getVisibilityAction(
  idOrSlug: string
): Promise<ActionState<VisibilityState>> {
  const requestId = generateRequestId();
  const timer = startTimer("getVisibilityAction");
  const log = createLogger({ requestId, action: "getVisibilityAction" });

  try {
    log.info("Action started: get visibility", { idOrSlug });

    const requester = await getOptionalRequester(requestId);
    const obj = await contentService.loadByIdOrSlug(idOrSlug);
    if (!obj) throw new NotFoundError("Content not found", { idOrSlug });

    // Mask existence: a non-viewable object 404s rather than revealing its grants.
    const viewable = await visibilityService.canView(requester, {
      id: obj.id,
      ownerUserId: obj.ownerUserId,
      visibilityLevel: obj.visibilityLevel,
    });
    if (!viewable) throw new NotFoundError("Content not found", { idOrSlug });

    // Group grants are only meaningful for a `group` object; load them regardless
    // (cheap, indexed) so the editor can show the prior selection if the level was
    // toggled away from group and back without losing the grant set in the UI.
    const grants = await visibilityService.grantsFor(obj.id);

    // The edit gate is resolved with the same helper the write action uses, so
    // the chip can render read-only for a viewer who is not the owner/admin.
    const editable = canEdit(requester, obj.ownerUserId);

    timer({ status: "success" });
    log.info("Visibility loaded", {
      objectId: obj.id,
      visibilityLevel: obj.visibilityLevel,
      grantCount: grants.length,
    });
    return createSuccess(
      {
        visibilityLevel: obj.visibilityLevel,
        grants,
        canEdit: editable,
      },
      "Visibility loaded"
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load visibility", {
      context: "getVisibilityAction",
      requestId,
      operation: "getVisibilityAction",
    });
  }
}
