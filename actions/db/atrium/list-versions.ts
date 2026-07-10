"use server"

/**
 * Atrium list-versions server action (#1052, Epic #1059, Phase 2)
 *
 * Returns an object's version history (newest-first) for the canvas version
 * dropdown and the provenance display. Visibility is enforced via
 * `contentService.get` (the `canView` gate), so a caller who cannot view the
 * object gets a NotFound — existence is not leaked, and a caller cannot enumerate
 * another object's version history.
 *
 * The DTOs include `authorActor` (human/agent) and `versionNumber` so the UI can
 * show per-version provenance (green = human, purple = agent) without a second
 * round trip. Bodies are NOT returned here — code is fetched per selected version
 * via `getArtifactCodeAction` (keeps this list cheap and avoids shipping every
 * version's untrusted source to the client at once).
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { contentService } from "@/lib/content";
import { versionService } from "@/lib/content/version-service";
import type { ActionState } from "@/types";
import { getOptionalRequester } from "./requester";

export interface VersionSummary {
  id: string;
  versionNumber: number;
  authorActor: "human" | "agent";
  // authorUserId is intentionally NOT exposed: it is a raw internal DB primary
  // key. The UI only needs `authorActor` (human/agent) for the provenance label;
  // returning the numeric user id to every viewer would leak a stable internal
  // identifier (user-id enumeration) for no client benefit.
  summary: string | null;
  createdAt: string | null;
  /** True when this is the object's current working head. */
  isCurrent: boolean;
}

export async function listVersionsAction(
  idOrSlug: string
): Promise<ActionState<VersionSummary[]>> {
  const requestId = generateRequestId();
  const timer = startTimer("listVersionsAction");
  const log = createLogger({ requestId, action: "listVersionsAction" });

  try {
    log.info("Action started: list versions", { idOrSlug });

    const requester = await getOptionalRequester(requestId);
    // Enforce canView + resolve the stable object id (idOrSlug may be a slug).
    const obj = await contentService.get(requester, idOrSlug);

    // Artifact-only, mirroring getArtifactCodeAction. The version dropdown this
    // feeds is an artifact-canvas surface; a document idOrSlug here is a caller
    // bug. canView already blocks non-viewable objects (no authorization bypass),
    // but without this guard a viewer could enumerate a visible DOCUMENT's version
    // provenance (authorActor, timestamps, version numbers) through an action that
    // is meant only for artifacts. Reject it the same way the code loader does.
    if (obj.kind !== "artifact") {
      throw ErrorFactories.validationFailed([
        { field: "idOrSlug", message: "Object is not an artifact" },
      ]);
    }

    const versions = await versionService.list(obj.id);

    const summaries: VersionSummary[] = versions.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      authorActor: v.authorActor,
      summary: v.summary,
      createdAt: v.createdAt,
      isCurrent: v.id === obj.currentVersionId,
    }));

    timer({ status: "success" });
    log.info("Versions listed", { objectId: obj.id, count: summaries.length });
    return createSuccess(summaries, "Versions listed");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to list versions", {
      context: "listVersionsAction",
      requestId,
      operation: "listVersionsAction",
    });
  }
}
