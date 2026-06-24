"use server"

/**
 * Atrium get-content server action
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). Thin wrapper over
 * `contentService.get` — loads an object (with its current version) by id or
 * slug, enforcing `canView` in the service. Returns 404-style (NotFound) for
 * both missing and non-viewable content so existence is not leaked.
 *
 * See docs/features/atrium-design-spec.md §11.2 / §12.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError } from "@/lib/error-utils";
import { contentService } from "@/lib/content";
import type { ContentObjectWithVersion } from "@/lib/content";
import type { ActionState } from "@/types";
import { getUserRequester } from "./requester";

export async function getContentAction(
  idOrSlug: string
): Promise<ActionState<ContentObjectWithVersion>> {
  const requestId = generateRequestId();
  const timer = startTimer("getContentAction");
  const log = createLogger({ requestId, action: "getContentAction" });

  try {
    log.info("Action started: get content", { idOrSlug });

    const requester = await getUserRequester();
    const result = await contentService.get(requester, idOrSlug);

    timer({ status: "success" });
    log.info("Content loaded", { objectId: result.id });
    return createSuccess(result, "Content loaded");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load content", {
      context: "getContentAction",
      requestId,
      operation: "getContentAction",
    });
  }
}
