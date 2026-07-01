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
  // Accepts a UUID OR a slug — resolved via `loadByIdOrSlug` below. Named to
  // match `getVisibilityAction` so a future reader does not add UUID-only
  // validation that silently breaks slug callers.
  idOrSlug: string,
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
      idOrSlug: sanitizeForLogging(idOrSlug),
      input: sanitizeForLogging({
        level: input?.level,
        grantCount: input?.grants?.length ?? 0,
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

    // Load the object and enforce view (mask existence → NotFound) then edit
    // permission BEFORE writing — the service's setLevel does not run permission
    // checks (it is also the publish path's primitive, which gates separately).
    //
    // SECURITY — order matters: existence/permission checks run BEFORE input
    // validation (assertLevel / assertGrantKind below). If validation ran first, a
    // caller probing a UUID they don't own with a bad `level` would get a
    // ValidationError, while a non-existent UUID gets NotFound — distinguishing
    // "exists but I sent garbage" from "absent" and defeating the existence
    // masking the rest of this flow enforces. Both an unowned and an absent object
    // must 404 identically regardless of input validity.
    const obj = await contentService.loadByIdOrSlug(idOrSlug);
    if (!obj) throw new NotFoundError("Content not found", { idOrSlug });
    const viewable = await visibilityService.canView(requester, {
      id: obj.id,
      ownerUserId: obj.ownerUserId,
      visibilityLevel: obj.visibilityLevel,
    });
    if (!viewable) throw new NotFoundError("Content not found", { idOrSlug });
    assertCanEdit(requester, obj.ownerUserId);

    // Only now (the caller is a confirmed editor of an existing object) validate
    // the input — a ValidationError here cannot leak existence to a non-editor.
    const level = assertLevel(input.level);
    const grants = (input.grants ?? []).map((g) => ({
      kind: assertGrantKind(g.kind),
      value: g.value,
    }));

    // TOCTOU note: `canView` / `assertCanEdit` run here against `obj` loaded
    // OUTSIDE the write transaction that `setLevel` opens, so the object's
    // ownership/visibility could in principle change between this check and the
    // write. This is acceptable: only the owner (or an admin) passes
    // `assertCanEdit`, ownership is effectively immutable, and `setLevel` re-loads
    // the row `FOR UPDATE` inside its transaction (serializing concurrent writes
    // and failing closed with NotFound if the row was deleted in the gap). The
    // worst case is an owner's own edit racing their own concurrent edit, which
    // the row lock orders deterministically.
    //
    // Target the resolved UUID (the input may be a slug) so a slug change between
    // load and write cannot retarget a different object.
    // §26.4 gate: widening to `public` requires authority. Mirroring the UI
    // publish-document action, the capability flag is left at its default (false),
    // so a non-admin UI user setting `public` hits the approval gate (admins pass
    // via `req.isAdmin` inside setLevel); it throws ApprovalRequiredError otherwise,
    // which handleError maps to the standard action-state error envelope.
    const result = await visibilityService.setLevel(requester, obj.id, {
      level,
      grants,
    });

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
