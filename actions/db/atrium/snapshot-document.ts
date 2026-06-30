"use server"

/**
 * Atrium snapshot-document server action
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). The document editor's snapshot
 * entrypoint: the debounced-idle / explicit "save" that captures a new immutable
 * version of a document's body. Thin wrapper over `versionService.snapshot` with
 * the document body format fixed to markdown. Edit permission is enforced in the
 * service; the surface adds the feature-capability gate.
 *
 * Distinct from `create-version.ts` (the generic body-change write path) only in
 * intent and entrypoint: this is the editor's autosave/save hook and always
 * targets a `document` in markdown.
 *
 * See docs/features/atrium-design-spec.md §14.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { versionService } from "@/lib/content";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { canEdit } from "@/lib/content/helpers";
import { NotFoundError, ForbiddenError } from "@/lib/content/errors";
import type { ContentVersionDTO } from "@/lib/content";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "./requester";

export async function snapshotDocumentAction(
  objectId: string,
  input: { body: string; summary?: string }
): Promise<ActionState<ContentVersionDTO>> {
  const requestId = generateRequestId();
  const timer = startTimer("snapshotDocumentAction");
  const log = createLogger({ requestId, action: "snapshotDocumentAction" });

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

    log.info("Action started: snapshot document", {
      objectId,
      input: sanitizeForLogging({
        hasBody: typeof input.body === "string",
        summary: input.summary,
      }),
    });

    // Enforce per-object edit authorization. The capability gate above checks
    // feature access; this check ensures the caller may edit THIS specific object
    // (owner or admin). Without it, any user with the atrium-content capability
    // can overwrite any known object's working head via the snapshot action.
    const obj = await contentService.loadByIdOrSlug(objectId);
    if (!obj) throw new NotFoundError("Content object not found", { objectId });
    const viewable = await visibilityService.canView(requester, {
      id: obj.id,
      ownerUserId: obj.ownerUserId,
      visibilityLevel: obj.visibilityLevel,
    });
    // Mask existence: a non-viewable object 404s rather than revealing — via a
    // 403 — that this UUID exists. Matches setVisibilityAction, getVisibilityAction,
    // and publishService.publish (§12.4). The edit gate (403) only applies once the
    // caller can already see the object.
    if (!viewable)
      throw new NotFoundError("Content object not found", { objectId });
    if (!canEdit(requester, obj.ownerUserId)) {
      throw new ForbiddenError("Not permitted to edit this content");
    }

    const version = await versionService.snapshot(
      requester,
      { id: obj.id, kind: "document" },
      { body: input.body, bodyFormat: "markdown", summary: input.summary }
    );

    timer({ status: "success" });
    log.info("Document snapshot created", {
      objectId,
      versionId: version.id,
      versionNumber: version.versionNumber,
    });
    return createSuccess(version, "Document saved");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to save document", {
      context: "snapshotDocumentAction",
      requestId,
      operation: "snapshotDocumentAction",
    });
  }
}
