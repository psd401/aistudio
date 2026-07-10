"use server"

/**
 * Atrium unpublish-document server action
 *
 * Issue #1054 (Epic #1059, Atrium Phase 4; destinations widened for Epic #1059
 * completion). Thin wrapper over `publishService.unpublish` — removes an
 * object's live publication at a destination (for `intranet`, also hides its
 * auto-created nav item). View + edit permission is enforced in the service
 * (existence-masked: a non-viewable object 404s, never 403s); the surface adds
 * the feature-capability gate, mirroring `publishDocumentAction`. Taking a
 * §26.4 public destination offline without authority surfaces as the same
 * pending-approval outcome as publishing it.
 *
 * See docs/features/atrium-design-spec.md §15.3 / §21 / §26.4.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { publishService } from "@/lib/content/publish-service";
import { ApprovalRequiredError } from "@/lib/content/errors";
import { assertEditorDestination } from "@/lib/content/validators";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "./requester";

export async function unpublishDocumentAction(
  objectId: string,
  input: {
    /** Widened `string`, narrowed at runtime via `assertEditorDestination`. */
    destination: string;
  }
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

    // Narrow the widened `string` destination at runtime BEFORE it reaches the
    // service's adapter registry (rejects `okf` and any unexpected value) via
    // the shared editor-destination guard in `lib/content/validators.ts`.
    const destination = assertEditorDestination(input.destination, "unpublish");

    const result = await publishService.unpublish(
      requester,
      objectId,
      destination
    );

    timer({ status: "success" });
    log.info("Document unpublished", {
      objectId,
      unpublished: result.unpublished,
    });
    return createSuccess(result, "Document unpublished");
  } catch (error) {
    timer({ status: "error" });
    // §26.4 gate: taking a public destination offline without authority is a
    // pending-approval outcome (approval-queue event emitted in the service), not a
    // failure — surface it distinctly so the editor can show an amber "submitted
    // for review" caption, mirroring publishDocumentAction. The editor's
    // destination picker exposes `public_web`, so a non-admin caller can land here.
    if (error instanceof ApprovalRequiredError) {
      log.info("Unpublish requires approval", { requestId });
      return {
        isSuccess: false,
        approvalRequired: true,
        message:
          "Unpublishing from this destination requires administrator approval — your request has been submitted for review.",
      };
    }
    return handleError(error, "Failed to unpublish document", {
      context: "unpublishDocumentAction",
      requestId,
      operation: "unpublishDocumentAction",
    });
  }
}
