"use server"

/**
 * Atrium set-visibility server action
 *
 * Issue #1053 (Epic #1059, Atrium Phase 3). The visibility editor's persistence
 * path: set an object's visibility level (and, for `group`, replace its grants).
 * Mirrors `publish-document`'s grant-kind validation and capability gate, but
 * changes visibility WITHOUT publishing — a user widening/narrowing who-may-view
 * before (or independent of) making it live.
 *
 * Enforcement (§12.4): the service runs `canView` first (mask existence → 404),
 * then `assertCanEdit` (only the owner/admin/delegated-agent may rewrite
 * visibility). The surface adds the Atrium authoring capability gate.
 *
 * See docs/features/atrium-design-spec.md §12 (permissions/visibility) / §15.3.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { assertCanEdit } from "@/lib/content/helpers";
import { NotFoundError } from "@/lib/content/errors";
import { assertGrantKind, assertLevel } from "@/lib/content/validators";
import type { VisibilityLevel } from "@/lib/content/types";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "./requester";

export async function setVisibilityAction(
  objectId: string,
  input: {
    level: string;
    /** Required (and only meaningful) when level === "group". */
    grants?: { kind: string; value: string }[];
  }
): Promise<ActionState<{ visibilityLevel: VisibilityLevel }>> {
  const requestId = generateRequestId();
  const timer = startTimer("setVisibilityAction");
  const log = createLogger({ requestId, action: "setVisibilityAction" });

  try {
    // Log FIRST (matching get-visibility/list-grant-options and the Server Action
    // Template) so unauthenticated, wrong-capability, and invalid-input failures
    // below still produce an "Action started" entry rather than being invisible in
    // the log stream. `input.level` is raw/untrusted here — sanitize it.
    log.info("Action started: set visibility", {
      objectId,
      input: sanitizeForLogging({
        level: input?.level,
        grantCount: input?.grants?.length ?? 0,
      }),
    });

    if (!objectId) {
      throw ErrorFactories.missingRequiredField("objectId");
    }
    if (!input) {
      throw ErrorFactories.missingRequiredField("input");
    }

    // Resolve the session ONCE and thread it through both the requester build and
    // the capability check (avoids a double getServerSession per action, and both
    // reads see the same session). Resolve the requester FIRST so an
    // unauthenticated caller gets a 401 (please log in) rather than a 403.
    const session = await getServerSession();
    // `getUserRequester` throws `authNoSession()` for a null session / sub, so
    // by this line `session` is guaranteed non-null with a `sub`. Use `session!`
    // (not `session?.`): optional chaining would pass `undefined` to
    // `hasCapabilityAccess`, which then re-resolves the session internally —
    // defeating the "both reads see the same session" invariant this block
    // promises. The non-null assertion makes that invariant visible here.
    const requester = await getUserRequester(requestId, session);
    if (!(await hasCapabilityAccess("atrium-content", session!.sub))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }

    const level = assertLevel(input.level);
    const grants = (input.grants ?? []).map((g) => ({
      kind: assertGrantKind(g.kind),
      value: g.value,
    }));

    // Load the object and enforce view (mask existence → NotFound) then edit
    // permission BEFORE writing — the service's setLevel does not run permission
    // checks (it is also the publish path's primitive, which gates separately).
    const obj = await contentService.loadByIdOrSlug(objectId);
    if (!obj) throw new NotFoundError("Content not found", { objectId });
    const viewable = await visibilityService.canView(requester, {
      id: obj.id,
      ownerUserId: obj.ownerUserId,
      visibilityLevel: obj.visibilityLevel,
    });
    if (!viewable) throw new NotFoundError("Content not found", { objectId });
    assertCanEdit(requester, obj.ownerUserId);

    // Target the resolved UUID (the input may be a slug) so a slug change between
    // load and write cannot retarget a different object.
    const result = await visibilityService.setLevel(obj.id, { level, grants });

    timer({ status: "success" });
    log.info("Visibility updated", {
      objectId: obj.id,
      visibilityLevel: result.visibilityLevel,
    });
    return createSuccess(result, "Visibility updated");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to update visibility", {
      context: "setVisibilityAction",
      requestId,
      operation: "setVisibilityAction",
    });
  }
}
