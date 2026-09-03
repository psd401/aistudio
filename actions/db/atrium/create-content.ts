"use server"

/**
 * Atrium create-content server action
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). Thin wrapper over
 * `contentService.create` — the in-app (logged-in human) surface for creating a
 * content object (optionally with an initial v1 body). External agents use REST
 * v1 / MCP over the same service (Phase 5); there is no UI-only write path.
 *
 * See docs/features/atrium-design-spec.md §11 / §35.1.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { contentService } from "@/lib/content";
import type {
  ContentObjectWithVersion,
  CreateObjectInput,
} from "@/lib/content";
import {
  decodeContentBody,
  type ContentCodeEncoding,
} from "@/lib/content/code-encoding";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getUserRequester } from "./requester";
import {
  IN_APP_PUBLISH_PUBLIC_CAPABILITY,
  notifyPublicExposure,
} from "@/lib/atrium/public-publish-policy";

export async function createContentAction(
  input: CreateObjectInput,
  // The library's artifact-create flow base64-encodes `input.body` and passes
  // `codeEncoding: "base64"` so a starter/seed body containing <script>/<style>
  // is opaque to the edge WAF (CrossSiteScripting_BODY) on this server-action
  // POST — without it the request is blocked with a bare 403 that never reaches
  // the app (#1714). The body is decoded here BEFORE the service screens and
  // size-caps it. Omit for raw text (the pre-existing contract is unchanged).
  opts?: { codeEncoding?: ContentCodeEncoding }
): Promise<ActionState<ContentObjectWithVersion>> {
  const requestId = generateRequestId();
  const timer = startTimer("createContentAction");
  const log = createLogger({ requestId, action: "createContentAction" });

  try {
    log.info("Action started: create content", {
      input: sanitizeForLogging({
        kind: input?.kind,
        title: input?.title,
        collectionId: input?.collectionId,
        hasBody: input?.body !== undefined,
        codeEncoding: opts?.codeEncoding,
        visibilityLevel: input?.visibility?.level,
        tags: input?.tags,
      }),
    });

    // Resolve the requester FIRST so an unauthenticated caller gets a 401
    // (authNoSession → "please log in") rather than a 403 — `hasCapabilityAccess`
    // returns false (not throws) on a missing session, so gating on it first would
    // surface "access denied" to a caller who simply needs to log in. Ordering it
    // first also removes the duplicate session-read + role-query: getUserRequester
    // already resolves the session and roles, and hasCapabilityAccess re-resolves
    // both internally.
    const requester = await getUserRequester(requestId);
    if (!(await hasCapabilityAccess("atrium-content"))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }
    // Decode a base64 (WAF-opaque) body to real content before it reaches the
    // service, so §28.3 guardrails/PII screening and the size caps always run on
    // the real content rather than the inert wrapper. With `codeEncoding`
    // omitted this is an identity pass-through, so `body: undefined` stays
    // undefined and the "no v1 snapshot" branch is unaffected.
    const body = decodeContentBody(input.body, opts?.codeEncoding);
    const result = await contentService.create(requester, { ...input, body }, {
      // #1336: any author may publish publicly — the same allow-then-notify
      // policy the publish / set-visibility actions apply. Without this the
      // create path still ran the §26.4 "create-as-private" downgrade, so a
      // non-admin creating content explicitly Public (or inside a collection
      // whose admin-set default is Public) silently got a PRIVATE object plus a
      // queued widen request — contradicting the policy and reproducing the
      // "make public does nothing visible" symptom at creation time.
      hasPublishPublicCapability: IN_APP_PUBLISH_PUBLIC_CAPABILITY,
    });

    // Allow-then-NOTIFY, on the same terms as publish/set-visibility: only when
    // the object actually RESOLVED to public (an explicit Public input, or a
    // public collection default), never merely because one was requested.
    if (result.visibilityLevel === "public") {
      await notifyPublicExposure({
        req: requester,
        action: "create",
        objectId: result.id,
        note: "Created with public visibility without administrator approval (allow-then-notify policy)",
        requestId,
      });
    }

    timer({ status: "success" });
    log.info("Content created", {
      objectId: result.id,
      kind: result.kind,
      versionId: result.version?.id ?? null,
    });
    return createSuccess(result, "Content created");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to create content", {
      context: "createContentAction",
      requestId,
      operation: "createContentAction",
    });
  }
}
