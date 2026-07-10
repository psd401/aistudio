"use server"

/**
 * Atrium publish-document server action
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1; destinations widened for Epic #1059
 * completion). Thin wrapper over `publishService.publish` — publishes an
 * object's working head to a destination for the logged-in human surface:
 * `intranet` (`/c/[slug]`), `public_web` (`/p/[slug]`, §26.4-gated), or the
 * `schoology`/`google` connector stubs (their adapters throw
 * `implemented:false` until wired). View + edit permission is enforced in the
 * service; the surface adds the feature-capability gate.
 *
 * See docs/features/atrium-design-spec.md §15 (publishing) / §26.4.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { publishService } from "@/lib/content/publish-service";
import { ApprovalRequiredError } from "@/lib/content/errors";
import {
  assertEditorDestination,
  assertGrantKind,
  assertLevel,
} from "@/lib/content/validators";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "./requester";

/**
 * The editor destination union (excludes `okf` — API/MCP-only by design),
 * re-exported from its canonical home in `lib/content/validators.ts` (which
 * derives it from the adapter registry's `PUBLISH_DESTINATIONS`) so existing
 * consumers (`unpublish-document.ts`, the `EditorToolbar` picker) keep their
 * import path. Type-only, so it is erased and legal in a "use server" module.
 */
export type { EditorPublishDestination } from "@/lib/content/validators";

export async function publishDocumentAction(
  objectId: string,
  input: {
    /**
     * Widened to `string` (the action/REST-style input contract) and narrowed at
     * runtime via `assertEditorDestination`. `intranet` publishes to the internal
     * reader; `public_web`/`schoology`/`google` are §26.4 public destinations —
     * a caller without public-publish authority gets the pending-approval
     * outcome, not a failure (see the ApprovalRequiredError branch below).
     */
    destination: string;
    /**
     * Optional visibility-widening applied in the publish transaction. `level`
     * arrives as a plain `string` (the action/REST/MCP input contract) and is
     * narrowed via `assertLevel` before reaching the service — matching the
     * service's full `VisibilityLevel` capability rather than narrowing to
     * `group` only at the type boundary. `grants` are only meaningful (and only
     * accepted by the service) for `level: "group"`.
     */
    visibility?: { level: string; grants?: { kind: string; value: string }[] };
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
    // `getUserRequester` throws `authNoSession()` for a null session / sub, so
    // `session` is non-null past this line. Use `session!.sub` (not `session?.`):
    // optional chaining would pass `undefined` to `hasCapabilityAccess`, which
    // re-resolves the session internally and breaks the same-session invariant.
    const requester = await getUserRequester(requestId, session);
    if (!(await hasCapabilityAccess("atrium-content", session!.sub))) {
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

    // Narrow the widened `string` destination at runtime BEFORE it reaches the
    // service's adapter registry (rejects `okf` and any unexpected value).
    const destination = assertEditorDestination(input.destination, "publish");

    // `input.visibility` carries a widened `level` and `grant.kind` (plain
    // `string`). `assertLevel` / `assertGrantKind` narrow each via a RUNTIME
    // check (throwing ValidationError on an unexpected value) before they reach
    // the service — the DB enum is the last line of defense, not the first.
    const result = await publishService.publish(requester, objectId, {
      destination,
      visibility: input.visibility
        ? {
            level: assertLevel(input.visibility.level),
            // `?? []` guard: `grants` is optional on the input contract (a REST/MCP
            // caller, or a future action passing `{ visibility: { level: "internal" } }`,
            // can omit it). Without the guard `undefined.map()` throws a TypeError —
            // mirrors the `(input.grants ?? []).map(...)` guard in set-visibility.ts.
            grants: (input.visibility.grants ?? []).map((g) => ({
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
    // §26.4 gate: a public-destination publish without approval is a
    // pending-approval outcome (approval-queue event emitted), not a failure.
    // Surface it distinctly — the editor's destination picker exposes
    // `public_web`, so a non-admin caller routinely lands here.
    if (error instanceof ApprovalRequiredError) {
      log.info("Publish requires approval", { requestId });
      return {
        isSuccess: false,
        approvalRequired: true,
        message:
          "Publishing to this destination requires administrator approval — your request has been submitted for review.",
      };
    }
    return handleError(error, "Failed to publish document", {
      context: "publishDocumentAction",
      requestId,
      operation: "publishDocumentAction",
    });
  }
}
