"use server";

/**
 * Atrium publish-document server action
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1; single Live state per #1726). Thin
 * wrapper over `publishService.publish` — flips the object LIVE for the logged-in
 * human surface. View + edit permission is enforced in the service; the surface
 * adds the feature-capability gate.
 *
 * It takes NO visibility input (#1726). Publishing is a state change; who may read
 * the page is the object's Level, saved separately through `setVisibilityAction`.
 * The old bundled widen existed to reconcile a second "where it's published"
 * audience switch that no longer exists, and its one visible effect on this
 * surface was replacing the author's grants with none.
 *
 * `destination` is still accepted (the connector stubs are real destinations, and
 * `public_web` remains a legacy alias the service folds onto the live row) but the
 * Share dialog no longer offers a choice.
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
import { assertEditorDestination } from "@/lib/content/validators";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "./requester";
import {
  IN_APP_PUBLISH_PUBLIC_CAPABILITY,
  notifyPublicExposure,
} from "@/lib/atrium/public-publish-policy";
import {
  isPublicDestination,
  LIVE_DESTINATION,
} from "@/lib/content/publish-adapters/types";

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
     * runtime via `assertEditorDestination`. `intranet` (and its legacy alias
     * `public_web`) flip the live switch; `schoology`/`google` are §26.4 connector
     * destinations — a caller without public-publish authority gets the
     * pending-approval outcome, not a failure (see the ApprovalRequiredError
     * branch below). Defaults to the live switch when omitted.
     */
    destination?: string;
  } = {},
): Promise<
  ActionState<{
    publicationId: string;
    publishedVersionId: string;
    /**
     * The reader URL the content is now served at (#1336 C3) — `/c/{slug}` for
     * the live switch. Surfaced so the success caption can offer a copyable link
     * instead of a bare "Published".
     */
    readerUrl: string | null;
  }>
> {
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

    log.info("Action started: publish document", {
      objectId,
      input: sanitizeForLogging({ destination: input.destination }),
    });

    // Narrow the widened `string` destination at runtime BEFORE it reaches the
    // service's adapter registry (rejects `okf` and any unexpected value).
    const destination = assertEditorDestination(
      input.destination ?? LIVE_DESTINATION,
      "publish"
    );

    const result = await publishService.publish(
      requester,
      objectId,
      { destination },
      {
        // #1336: any author may publish publicly — no admin approval gate. See
        // lib/atrium/public-publish-policy.ts for why this is supplied
        // here rather than by weakening the service's §26.4 gate.
        hasPublishPublicCapability: IN_APP_PUBLISH_PUBLIC_CAPABILITY,
      },
    );

    // Allow-then-NOTIFY. Best-effort and post-commit, so it can never fail or
    // roll back the publish the author just completed. Two things are notified:
    //
    //  - a CONNECTOR destination, which pushes a copy into an external
    //    family-facing system, and
    //  - `becamePubliclyReachable` — this publish took a `public` object from
    //    Draft to Live, which is the moment `/p/{slug}` starts serving anonymous
    //    visitors and the sitemap starts advertising it.
    //
    // The second arm is not redundant with `setVisibilityAction`, which notifies
    // on the transition TO `public`. Public and Live are independent switches and
    // the exposure happens when the SECOND of them lands, so notifying only on
    // the visibility write covered "Live first, then Public" and silently missed
    // "Public first, then Live" — the same end state, recorded or not depending
    // on which order the author happened to click.
    //
    // Both read the COMMITTED outcome rather than the request:
    // `becamePubliclyReachable` is observed under the row lock inside the publish
    // transaction, so a republish of an already-live public page — which exposes
    // nothing new — files nothing.
    if (isPublicDestination(destination)) {
      await notifyPublicExposure({
        req: requester,
        action: "publish",
        objectId,
        destination,
        note: `Published to ${destination} without administrator approval (allow-then-notify policy)`,
        requestId,
      });
    } else if (result.becamePubliclyReachable) {
      await notifyPublicExposure({
        req: requester,
        action: "publish",
        objectId,
        destination,
        note: "Made live while Public, so it is now readable by anyone without signing in (allow-then-notify policy)",
        requestId,
      });
    }

    timer({ status: "success" });
    log.info("Document published", {
      objectId,
      publicationId: result.publicationId,
      publishedVersionId: result.publishedVersionId,
    });
    return createSuccess(result, "Document published");
  } catch (error) {
    timer({ status: "error" });
    // §26.4 gate: a connector-destination publish without approval is a
    // pending-approval outcome (approval-queue event emitted), not a failure.
    // Surface it distinctly rather than as a red error.
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
