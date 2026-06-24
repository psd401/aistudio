"use server"

/**
 * Atrium create-version server action
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). Thin wrapper over
 * `contentService.createVersion` — snapshots a new immutable version of an
 * existing object (the body-change write path) for the logged-in human surface.
 * Edit permission is enforced in the service.
 *
 * See docs/features/atrium-design-spec.md §14 / §35.1.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { contentService } from "@/lib/content";
import type { ContentObjectWithVersion, SnapshotInput } from "@/lib/content";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getUserRequester } from "./requester";

export async function createVersionAction(
  objectId: string,
  input: SnapshotInput
): Promise<ActionState<ContentObjectWithVersion>> {
  const requestId = generateRequestId();
  const timer = startTimer("createVersionAction");
  const log = createLogger({ requestId, action: "createVersionAction" });

  try {
    log.info("Action started: create version", {
      objectId,
      input: sanitizeForLogging({
        bodyFormat: input?.bodyFormat,
        hasBody: typeof input?.body === "string",
        summary: input?.summary,
      }),
    });

    const requester = await getUserRequester();
    // UI write path: gate on the Atrium content capability (see create-content).
    if (!(await hasCapabilityAccess("atrium-content"))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }
    const result = await contentService.createVersion(
      requester,
      objectId,
      input
    );

    timer({ status: "success" });
    log.info("Version created", {
      objectId: result.id,
      versionId: result.version?.id ?? null,
      versionNumber: result.version?.versionNumber ?? null,
    });
    return createSuccess(result, "Version created");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to create version", {
      context: "createVersionAction",
      requestId,
      operation: "createVersionAction",
    });
  }
}
