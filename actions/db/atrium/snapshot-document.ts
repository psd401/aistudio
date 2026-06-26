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
import type { ContentVersionDTO } from "@/lib/content";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getUserRequester } from "./requester";

export async function snapshotDocumentAction(
  objectId: string,
  input: { body: string; summary?: string }
): Promise<ActionState<ContentVersionDTO>> {
  const requestId = generateRequestId();
  const timer = startTimer("snapshotDocumentAction");
  const log = createLogger({ requestId, action: "snapshotDocumentAction" });

  try {
    log.info("Action started: snapshot document", {
      objectId,
      input: sanitizeForLogging({
        hasBody: typeof input?.body === "string",
        summary: input?.summary,
      }),
    });

    // Resolve the requester FIRST so an unauthenticated caller gets a 401
    // (authNoSession → "please log in") rather than a 403 — `hasCapabilityAccess`
    // returns false (not throws) on a missing session, so gating on it first would
    // surface "access denied" to a caller who simply needs to log in. Ordering it
    // first also removes the duplicate session-read + role-query.
    const requester = await getUserRequester(requestId);
    if (!(await hasCapabilityAccess("atrium-content"))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }

    const version = await versionService.snapshot(
      requester,
      { id: objectId, kind: "document" },
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
