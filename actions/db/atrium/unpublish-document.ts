"use server"

/**
 * Atrium unpublish-document server action
 *
 * Issue #1054 (Epic #1059, Atrium Phase 4). Thin wrapper over
 * `publishService.unpublish` — removes a document's live intranet publication and
 * hides its auto-created nav item. View + edit permission is enforced in the
 * service (existence-masked: a non-viewable object 404s, never 403s); the surface
 * adds the feature-capability gate, mirroring `publishDocumentAction`.
 *
 * See docs/features/atrium-design-spec.md §15.3 / §21.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { publishService } from "@/lib/content/publish-service";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "./requester";

export async function unpublishDocumentAction(
  objectId: string,
  input: { destination: "intranet" }
): Promise<ActionState<{ unpublished: boolean }>> {
  const requestId = generateRequestId();
  const timer = startTimer("unpublishDocumentAction");
  const log = createLogger({ requestId, action: "unpublishDocumentAction" });

  try {
    // Resolve the session ONCE and thread it through both the requester build and
    // the capability check — mirrors publishDocumentAction.
    const session = await getServerSession();
    // Requester FIRST so an unauthenticated caller gets a 401, not a 403
    // (hasCapabilityAccess returns false on a null session). `getUserRequester`
    // already throws authNoSession() for a null session; the explicit guard below
    // restates that for the type system so the capability check reads `session.sub`
    // without a fragile non-null assertion (and a future reorder fails loud, not
    // with a TypeError). The same `session` object is reused — same-session invariant
    // preserved (never re-resolve via optional chaining → undefined → re-read).
    const requester = await getUserRequester(requestId, session);
    if (!session) {
      throw ErrorFactories.authNoSession();
    }
    if (!(await hasCapabilityAccess("atrium-content", session.sub))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }

    if (!input) {
      throw ErrorFactories.missingRequiredField("input");
    }

    log.info("Action started: unpublish document", {
      objectId,
      destination: input.destination,
    });

    const result = await publishService.unpublish(
      requester,
      objectId,
      input.destination
    );

    timer({ status: "success" });
    log.info("Document unpublished", {
      objectId,
      unpublished: result.unpublished,
    });
    return createSuccess(result, "Document unpublished");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to unpublish document", {
      context: "unpublishDocumentAction",
      requestId,
      operation: "unpublishDocumentAction",
    });
  }
}
