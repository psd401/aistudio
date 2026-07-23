"use server"

/**
 * Atrium collection-tree server action
 *
 * Issue #1054 (Epic #1059, Atrium Phase 4). Thin wrapper over
 * `collectionService.tree` — returns the requester-visible collection tree (the
 * intranet section tree / reader sidebar). The tree is permission-filtered in the
 * service: a section the requester cannot enter (no level access AND no visible
 * object inside) is pruned, so a user never sees a section they cannot enter
 * (spec §21).
 *
 * Like `listContentAction`, this read is NOT gated by `hasCapabilityAccess`:
 * visibility is bounded entirely by `canView`. A guest (no session) sees only
 * `public` sections.
 *
 * See docs/features/atrium-design-spec.md §21.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError } from "@/lib/error-utils";
import { collectionService } from "@/lib/content";
import type { CollectionTreeNode } from "@/lib/content";
import type { ActionState } from "@/types";
import { getOptionalRequester } from "./requester";

export async function collectionTreeAction(): Promise<
  ActionState<CollectionTreeNode[]>
> {
  const requestId = generateRequestId();
  const timer = startTimer("collectionTreeAction");
  const log = createLogger({ requestId, action: "collectionTreeAction" });

  try {
    log.info("Action started: collection tree");

    const requester = await getOptionalRequester(requestId);
    const tree = await collectionService.tree(requester);

    timer({ status: "success" });
    log.info("Collection tree built", { rootCount: tree.length });
    return createSuccess(tree, "Collection tree built");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to build collection tree", {
      context: "collectionTreeAction",
      requestId,
      operation: "collectionTreeAction",
    });
  }
}
