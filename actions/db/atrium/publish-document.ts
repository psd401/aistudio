"use server"

/**
 * Atrium publish-document server action
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). Thin wrapper over
 * `publishService.publish` — publishes a document's working head to the intranet
 * reader (`/c/[slug]`) for the logged-in human surface. View + edit permission is
 * enforced in the service; the surface adds the feature-capability gate.
 *
 * See docs/features/atrium-design-spec.md §15 (publishing).
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { publishService } from "@/lib/content/publish-service";
import { assertGrantKind } from "@/lib/content/validators";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "./requester";

export async function publishDocumentAction(
  objectId: string,
  input: {
    destination: "intranet";
    visibility?: { level: "group"; grants: { kind: string; value: string }[] };
  }
): Promise<ActionState<{ publicationId: string; publishedVersionId: string }>> {
  const requestId = generateRequestId();
  const timer = startTimer("publishDocumentAction");
  const log = createLogger({ requestId, action: "publishDocumentAction" });

  try {
    // Resolve the session ONCE and thread it through both the requester build and
    // the capability check — avoids a double getServerSession() (JWT verify +
    // cookie parse) per action and guarantees both reads see the same session.
    const session = await getServerSession();
    // Resolve the requester FIRST so an unauthenticated caller gets a 401
    // (authNoSession → "please log in") rather than a 403 — `hasCapabilityAccess`
    // returns false (not throws) on a missing session, so gating on it first would
    // surface "access denied" to a caller who simply needs to log in.
    const requester = await getUserRequester(requestId, session);
    if (!(await hasCapabilityAccess("atrium-content", session?.sub))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }

    if (!input) {
      throw ErrorFactories.missingRequiredField("input");
    }

    log.info("Action started: publish document", {
      objectId,
      input: sanitizeForLogging({
        destination: input.destination,
        visibilityLevel: input.visibility?.level,
        grantCount: input.visibility?.grants?.length ?? 0,
      }),
    });

    // `input.visibility` carries a widened `grant.kind` (plain `string`).
    // `assertGrantKind` narrows it via a RUNTIME check (throwing ValidationError on
    // an unexpected value) before it reaches `visibilityService.applyGrants` — the
    // DB enum is the last line of defense, not the first.
    const result = await publishService.publish(requester, objectId, {
      destination: input.destination,
      visibility: input.visibility
        ? {
            level: input.visibility.level,
            grants: input.visibility.grants.map((g) => ({
              kind: assertGrantKind(g.kind),
              value: g.value,
            })),
          }
        : undefined,
    });

    timer({ status: "success" });
    log.info("Document published", {
      objectId,
      publicationId: result.publicationId,
      publishedVersionId: result.publishedVersionId,
    });
    return createSuccess(result, "Document published");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to publish document", {
      context: "publishDocumentAction",
      requestId,
      operation: "publishDocumentAction",
    });
  }
}
