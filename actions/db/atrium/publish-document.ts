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
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
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
    // Resolve the requester FIRST so an unauthenticated caller gets a 401
    // (authNoSession → "please log in") rather than a 403 — `hasCapabilityAccess`
    // returns false (not throws) on a missing session, so gating on it first would
    // surface "access denied" to a caller who simply needs to log in.
    const requester = await getUserRequester(requestId);
    if (!(await hasCapabilityAccess("atrium-content"))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }

    if (!input) {
      throw new Error("Input parameters are required");
    }

    log.info("Action started: publish document", {
      objectId,
      input: sanitizeForLogging({
        destination: input.destination,
        visibilityLevel: input.visibility?.level,
        grantCount: input.visibility?.grants?.length ?? 0,
      }),
    });

    // `input.visibility` carries a widened `grant.kind` (plain `string`); the
    // service's `applyGrants` validates each grant value and the kind is narrowed
    // to `GrantKind` by the DB enum, so pass it through as the service's
    // VisibilityGrant shape.
    const result = await publishService.publish(requester, objectId, {
      destination: input.destination,
      visibility: input.visibility
        ? {
            level: input.visibility.level,
            grants: input.visibility.grants.map((g) => ({
              kind: g.kind as "role" | "building" | "department" | "grade" | "user",
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
