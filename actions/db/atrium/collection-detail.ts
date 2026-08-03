"use server"

/**
 * Atrium collection-detail server action — the data behind a section landing
 * page (`/atrium/s/[slug]`).
 *
 * SECURITY: `collectionService.detail` resolves the section out of the
 * requester-filtered tree, so a section the caller cannot enter comes back as
 * `null` exactly like a section that does not exist. The caller renders a 404
 * for both; do NOT introduce a distinct "forbidden" response here, which would
 * confirm the section exists and let a probe enumerate the district's structure
 * by slug.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError } from "@/lib/error-utils";
import { collectionService } from "@/lib/content/collection-service";
import type { CollectionTreeNode } from "@/lib/content/collection-service";
import type { ActionState } from "@/types";
import { getOptionalRequester } from "./requester";

export interface CollectionDetailResult {
  node: CollectionTreeNode;
  breadcrumb: CollectionTreeNode[];
  subtreeIds: string[];
}

export async function collectionDetailAction(
  slugOrId: string
): Promise<ActionState<CollectionDetailResult | null>> {
  const requestId = generateRequestId();
  const timer = startTimer("collectionDetailAction");
  const log = createLogger({ requestId, action: "collectionDetailAction" });

  try {
    log.info("Action started: collection detail", { slugOrId });

    const requester = await getOptionalRequester(requestId);
    const detail = await collectionService.detail(requester, slugOrId);

    timer({ status: "success" });
    // `null` is a SUCCESS carrying "no such visible section" — the caller 404s.
    // Returning an error here would make the two cases distinguishable to a
    // client that can read `isSuccess`.
    return createSuccess(detail, detail ? "Section loaded" : "Section not found");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load the section", {
      context: "collectionDetailAction",
      requestId,
      operation: "collectionDetailAction",
    });
  }
}
