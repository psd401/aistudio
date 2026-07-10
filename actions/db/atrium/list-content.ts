"use server"

/**
 * Atrium list-content server action
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). Thin wrapper over
 * `contentService.list` — returns exactly the objects visible to the caller,
 * with permission filtering pushed into SQL (no load-then-drop, §12.3).
 *
 * Pagination: `filter.limit` / `filter.offset` flow through to
 * `visibilityService.listVisible`, which clamps limit to [1, 200] (default 50)
 * and coerces non-finite values to the defaults. Ordering is deterministic
 * (`updated_at DESC, id DESC` — unique-PK tiebreak), so sequential offset pages
 * neither skip nor repeat rows; the LibraryView "Load more" control pages this
 * way at 50/page.
 *
 * See docs/features/atrium-design-spec.md §11.2 / §12.3.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger";
import { createSuccess, handleError } from "@/lib/error-utils";
import { contentService } from "@/lib/content";
import type { ContentObjectDTO, ListFilter } from "@/lib/content";
import type { ActionState } from "@/types";
import { getOptionalRequester } from "./requester";

export async function listContentAction(
  filter: ListFilter = {}
): Promise<ActionState<ContentObjectDTO[]>> {
  const requestId = generateRequestId();
  const timer = startTimer("listContentAction");
  const log = createLogger({ requestId, action: "listContentAction" });

  try {
    log.info("Action started: list content", {
      filter: sanitizeForLogging(filter),
    });

    // DELIBERATE: list is NOT gated by `hasCapabilityAccess`. Results are bounded
    // by the permission-pushed `canView` SQL in `visibilityService.listVisible`
    // (a row is returned only if the requester could view it). A user without the
    // Atrium *authoring* capability still legitimately lists content visible to
    // them. Do not add a capability gate here without a product decision — write
    // actions are the gated ones. A guest (no session) lists only `public`
    // content via the same SQL filter.
    const requester = await getOptionalRequester(requestId);
    const result = await contentService.list(requester, filter);

    timer({ status: "success" });
    log.info("Content listed", { count: result.length });
    return createSuccess(result, "Content listed");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to list content", {
      context: "listContentAction",
      requestId,
      operation: "listContentAction",
    });
  }
}
