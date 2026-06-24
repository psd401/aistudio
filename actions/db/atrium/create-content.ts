"use server"

/**
 * Atrium create-content server action
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). Thin wrapper over
 * `contentService.create` — the in-app (logged-in human) surface for creating a
 * content object (optionally with an initial v1 body). External agents use REST
 * v1 / MCP over the same service (Phase 5); there is no UI-only write path.
 *
 * See docs/features/atrium-design-spec.md §11 / §35.1.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { contentService } from "@/lib/content";
import type {
  ContentObjectWithVersion,
  CreateObjectInput,
} from "@/lib/content";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getUserRequester } from "./requester";

export async function createContentAction(
  input: CreateObjectInput
): Promise<ActionState<ContentObjectWithVersion>> {
  const requestId = generateRequestId();
  const timer = startTimer("createContentAction");
  const log = createLogger({ requestId, action: "createContentAction" });

  try {
    log.info("Action started: create content", {
      input: sanitizeForLogging({
        kind: input?.kind,
        title: input?.title,
        collectionId: input?.collectionId,
        hasBody: input?.body !== undefined,
        visibilityLevel: input?.visibility?.level,
        tags: input?.tags,
      }),
    });

    // Capability gate first: avoids two DB queries (user + roles) for callers
    // who don't have the atrium-content capability (e.g. students).
    if (!(await hasCapabilityAccess("atrium-content"))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }
    const requester = await getUserRequester(requestId);
    const result = await contentService.create(requester, input);

    timer({ status: "success" });
    log.info("Content created", {
      objectId: result.id,
      kind: result.kind,
      versionId: result.version?.id ?? null,
    });
    return createSuccess(result, "Content created");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to create content", {
      context: "createContentAction",
      requestId,
      operation: "createContentAction",
    });
  }
}
