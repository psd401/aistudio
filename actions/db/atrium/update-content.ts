"use server"

/**
 * Atrium update-content server action (Epic #1059 completion)
 *
 * Thin wrapper over `contentService.update` — the in-app (logged-in human)
 * surface for metadata-only patches: rename, tags, collection move, and the
 * draft/archived status transitions. Body changes NEVER flow through here (they
 * go through the snapshot/create-version actions), and `status: "published"` is
 * rejected by the service (publishing must go through `publishService.publish`,
 * which owns the publication row + the §26.4 gate).
 *
 * Gate ordering mirrors `create-content.ts` / `publish-document.ts`:
 * requester FIRST (an unauthenticated caller gets a 401 "please log in", not a
 * 403), then the `atrium-content` feature-capability gate, then the service —
 * which enforces existence-masking (404 before 403) and `assertCanEdit`.
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
import { ValidationError } from "@/lib/content/errors";
import type { ContentObjectDTO, UpdatePatch } from "@/lib/content";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "./requester";

/**
 * The status transitions the editor surface may request. `published` is
 * deliberately absent — the service rejects it too (publish is a separate,
 * gated flow) — so an invalid value fails here as a clear 400 rather than
 * deeper in the service.
 */
const EDITOR_STATUSES = ["draft", "archived"] as const;
type EditorStatus = (typeof EDITOR_STATUSES)[number];

/** Runtime-narrow a widened `string` status; mirrors `assertLevel`'s pattern. */
function assertEditorStatus(status: string): EditorStatus {
  if (!(EDITOR_STATUSES as readonly string[]).includes(status)) {
    throw new ValidationError(
      `Invalid status: ${status} (use the publish action to publish)`,
      { status }
    );
  }
  return status as EditorStatus;
}

export async function updateContentAction(
  // Accepts a UUID OR a slug — `contentService.update` resolves via
  // `loadByIdOrSlug`. Named to match the other slug-tolerant actions.
  idOrSlug: string,
  input: {
    title?: string;
    /** `null` clears the tags (persisted as `[]` by the service). */
    tags?: string[] | null;
    /** `null` removes the object from its collection. */
    collectionId?: string | null;
    /** Widened `string`, narrowed at runtime; "draft" | "archived" only. */
    status?: string;
  }
): Promise<ActionState<ContentObjectDTO>> {
  const requestId = generateRequestId();
  const timer = startTimer("updateContentAction");
  const log = createLogger({ requestId, action: "updateContentAction" });

  try {
    log.info("Action started: update content", {
      idOrSlug: sanitizeForLogging(idOrSlug),
      input: sanitizeForLogging({
        hasTitle: input?.title !== undefined,
        hasTags: input?.tags !== undefined,
        hasCollection: input?.collectionId !== undefined,
        status: input?.status,
      }),
    });

    if (!idOrSlug) {
      throw ErrorFactories.missingRequiredField("idOrSlug");
    }
    if (!input) {
      throw ErrorFactories.missingRequiredField("input");
    }

    // Resolve the session ONCE and thread it through both the requester build and
    // the capability check (avoids a double getServerSession per action, and both
    // reads see the same session). Requester FIRST so an unauthenticated caller
    // gets a 401 (please log in) rather than a 403 — `hasCapabilityAccess`
    // returns false (not throws) on a missing session. `getUserRequester` throws
    // `authNoSession()` for a null session/sub, so `session` is non-null past
    // that line; `session!.sub` (not `session?.`) preserves the same-session
    // invariant (optional chaining would pass `undefined` and make
    // `hasCapabilityAccess` re-resolve the session internally).
    const session = await getServerSession();
    const requester = await getUserRequester(requestId, session);
    if (!(await hasCapabilityAccess("atrium-content", session!.sub))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }

    // Build the patch from ONLY the provided fields so an omitted field is never
    // written (the service handles `?? null` for the clearable ones). The status
    // string is runtime-narrowed before it reaches the service.
    const patch: UpdatePatch = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.tags !== undefined) patch.tags = input.tags;
    if (input.collectionId !== undefined) patch.collectionId = input.collectionId;
    if (input.status !== undefined) patch.status = assertEditorStatus(input.status);

    if (Object.keys(patch).length === 0) {
      throw new ValidationError("Nothing to update", {});
    }

    // The service enforces existence-masking (a non-viewable object 404s before
    // any edit-permission signal) then `assertCanEdit`.
    const result = await contentService.update(requester, idOrSlug, patch);

    timer({ status: "success" });
    log.info("Content updated", {
      objectId: result.id,
      status: result.status,
      collectionId: result.collectionId,
    });
    return createSuccess(result, "Content updated");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to update content", {
      context: "updateContentAction",
      requestId,
      operation: "updateContentAction",
    });
  }
}
