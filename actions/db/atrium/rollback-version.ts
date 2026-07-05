"use server"

/**
 * Atrium version-history + rollback server actions (Epic #1059 completion)
 *
 * The version-restore surface for BOTH content kinds:
 *
 * - `listContentVersionsAction` — an object's version history (newest-first)
 *   for the VersionMenu / ArtifactCanvas restore UI. Unlike the Phase 2
 *   `listVersionsAction` (which is deliberately artifact-only for the canvas
 *   dropdown), this action serves documents too: the version-history UI is a
 *   product surface for both kinds, and access is bounded by the same `canView`
 *   gate (`contentService.get` 404-masks a non-viewable object, so a caller
 *   cannot enumerate another object's provenance).
 *
 * - `rollbackVersionAction` — points the object's working head at an earlier
 *   version via `versionService.rollback`, which enforces existence-masking
 *   (canView -> 404 before any edit signal) and `assertCanEdit`, and validates
 *   the target version belongs to the object. Re-publishing the rolled-back
 *   version stays an explicit, separate publish step (spec §14/§15).
 *
 * Gate ordering for the write mirrors `publish-document.ts`: requester FIRST
 * (401 before 403), then the `atrium-content` capability, then the service.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { contentService } from "@/lib/content";
import { versionService } from "@/lib/content/version-service";
import { NotFoundError } from "@/lib/content/errors";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getServerSession } from "@/lib/auth/server-session";
import { getOptionalRequester, getUserRequester } from "./requester";
import type { VersionSummary } from "./list-versions";

export async function listContentVersionsAction(
  idOrSlug: string
): Promise<ActionState<VersionSummary[]>> {
  const requestId = generateRequestId();
  const timer = startTimer("listContentVersionsAction");
  const log = createLogger({ requestId, action: "listContentVersionsAction" });

  try {
    log.info("Action started: list content versions", { idOrSlug });

    // Read path: like listVersionsAction, NOT capability-gated — visibility is
    // bounded entirely by canView (contentService.get 404-masks).
    const requester = await getOptionalRequester(requestId);
    const obj = await contentService.get(requester, idOrSlug);

    const versions = await versionService.list(obj.id);

    // Same DTO shape as listVersionsAction (VersionSummary): authorUserId stays
    // deliberately unexposed (anti-enumeration — see list-versions.ts).
    const summaries: VersionSummary[] = versions.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      authorActor: v.authorActor,
      summary: v.summary,
      createdAt: v.createdAt,
      isCurrent: v.id === obj.currentVersionId,
    }));

    timer({ status: "success" });
    log.info("Content versions listed", {
      objectId: obj.id,
      count: summaries.length,
    });
    return createSuccess(summaries, "Versions listed");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to list versions", {
      context: "listContentVersionsAction",
      requestId,
      operation: "listContentVersionsAction",
    });
  }
}

export async function rollbackVersionAction(
  idOrSlug: string,
  toVersionId: string
): Promise<ActionState<{ objectId: string; currentVersionId: string }>> {
  const requestId = generateRequestId();
  const timer = startTimer("rollbackVersionAction");
  const log = createLogger({ requestId, action: "rollbackVersionAction" });

  try {
    log.info("Action started: rollback version", {
      idOrSlug: sanitizeForLogging(idOrSlug),
      toVersionId,
    });

    if (!idOrSlug) {
      throw ErrorFactories.missingRequiredField("idOrSlug");
    }
    if (!toVersionId) {
      throw ErrorFactories.missingRequiredField("toVersionId");
    }

    // Session ONCE, threaded into both the requester build and the capability
    // check; requester FIRST so an unauthenticated caller gets a 401, not a 403
    // (mirrors publish-document.ts — see its comments for the `session!.sub`
    // same-session invariant).
    const session = await getServerSession();
    const requester = await getUserRequester(requestId, session);
    if (!(await hasCapabilityAccess("atrium-content", session!.sub))) {
      throw ErrorFactories.authzToolAccessDenied("atrium-content");
    }

    // Resolve a possible slug to the stable UUID (`versionService.rollback`
    // queries by object id). No permission signal leaks here: an absent object
    // 404s, and the service re-runs canView (404-mask) + assertCanEdit against
    // the resolved id before writing.
    const obj = await contentService.loadByIdOrSlug(idOrSlug);
    if (!obj) throw new NotFoundError("Content not found", { idOrSlug });

    await versionService.rollback(requester, obj.id, toVersionId);

    timer({ status: "success" });
    log.info("Version restored as working head", {
      objectId: obj.id,
      toVersionId,
    });
    return createSuccess(
      { objectId: obj.id, currentVersionId: toVersionId },
      "Version restored"
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to restore version", {
      context: "rollbackVersionAction",
      requestId,
      operation: "rollbackVersionAction",
    });
  }
}
