"use server"

/**
 * Atrium delete-content server action (Atrium hard delete)
 *
 * The in-app (logged-in human) surface for PERMANENTLY deleting a content
 * object — the Meridian "Delete" affordance in the editor's content-settings
 * dialog. A thin wrapper over `contentService.delete`, which owns the guards:
 * existence-masking (404 before 403), the owner/admin `assertCanDelete` gate, and
 * the live-publication refusal (409 — delete never auto-unpublishes). It also
 * writes the transactional `delete` audit row and cleans up the cascade + S3.
 *
 * Gate ordering mirrors `update-content.ts`: requester FIRST (an unauthenticated
 * caller gets 401 "please log in", not 403), then the `atrium-content`
 * feature-capability gate, then the service. `surface: "ui"` tags the audit row
 * as an in-app human action.
 *
 * See docs/features/atrium-design-spec.md §11.2.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { contentService } from "@/lib/content";
import type { DeletedContentSummary } from "@/lib/content";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "./requester";

export async function deleteContentAction(
  // Accepts a UUID OR a slug — `contentService.delete` resolves via
  // `loadByIdOrSlug`, matching the other slug-tolerant actions.
  idOrSlug: string
): Promise<ActionState<DeletedContentSummary>> {
  const requestId = generateRequestId();
  const timer = startTimer("deleteContentAction");
  const log = createLogger({ requestId, action: "deleteContentAction" });

  try {
    log.info("Action started: delete content", {
      idOrSlug: sanitizeForLogging(idOrSlug),
    });

    if (!idOrSlug) {
      throw ErrorFactories.missingRequiredField("idOrSlug");
    }

    // Session resolved ONCE, threaded through the requester build + capability
    // check (see update-content.ts for the same-session rationale). Requester
    // FIRST so an unauthenticated caller gets a 401, not a 403.
    const session = await getServerSession();
    const requester = await getUserRequester(requestId, session);
    if (!(await hasCapabilityAccess("atrium-content", session!.sub))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }

    // The service enforces existence-masking (404 before 403), the owner/admin
    // delete gate, and the live-publication refusal (409). `ui` = in-app human.
    const result = await contentService.delete(requester, idOrSlug, {
      surface: "ui",
    });

    timer({ status: "success" });
    log.info("Content deleted", {
      objectId: result.id,
      versionsDeleted: result.versionsDeleted,
    });
    return createSuccess(result, "Content deleted");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to delete content", {
      context: "deleteContentAction",
      requestId,
      operation: "deleteContentAction",
    });
  }
}
