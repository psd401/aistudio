"use server"

/**
 * Atrium tag-suggestion server action
 *
 * Backs the typeahead under the library's tag box. Tags were effectively
 * undiscoverable before this: the filter demanded a whole tag, and nothing in
 * the UI told you which whole tags existed, so the only way to use the control
 * was to already know the answer.
 *
 * Like `listContentAction`, this is NOT capability-gated — and for the same
 * reason it does not need to be. `visibilityService.listVisibleTags` runs the
 * suggestion query behind the identical permission-pushed predicates as
 * `listVisible`, so a caller can only ever be suggested a tag that appears on
 * an object they could already have listed. A guest sees tags on `public`
 * content and nothing else.
 *
 * See docs/features/atrium-design-spec.md §12.3.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError } from "@/lib/error-utils";
import { visibilityService } from "@/lib/content";
import type { ActionState } from "@/types";
import { getOptionalRequester } from "./requester";
import { z } from "zod";

const tagQuerySchema = z.object({
  /**
   * The partially-typed tag. Empty is legal and returns the first page of
   * visible tags, which is what the box shows on focus before any typing.
   */
  prefix: z.string().max(100).default(""),
  limit: z.number().int().min(1).max(50).optional(),
});

export async function listContentTagsAction(
  input: { prefix?: string; limit?: number } = {}
): Promise<ActionState<string[]>> {
  const requestId = generateRequestId();
  const timer = startTimer("listContentTagsAction");
  const log = createLogger({ requestId, action: "listContentTagsAction" });

  try {
    const { prefix, limit } = tagQuerySchema.parse(input);
    // The prefix itself is user-typed search text and is NOT logged: it is a
    // fragment of whatever the person is looking for, and the tag corpus
    // includes personnel and student-support topics.
    log.info("Action started: list content tags", { prefixLength: prefix.length });

    const requester = await getOptionalRequester(requestId);
    const tags = await visibilityService.listVisibleTags(requester, prefix, limit);

    timer({ status: "success" });
    log.info("Content tags listed", { count: tags.length });
    return createSuccess(tags, "Tags listed");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to list tags", {
      context: "listContentTagsAction",
      requestId,
      operation: "listContentTagsAction",
    });
  }
}
