"use server"

/**
 * Atrium get-artifact-code server action (#1052, Epic #1059, Phase 2)
 *
 * Loads the raw artifact source (HTML/JS) for one version of an artifact object,
 * for the Preview/Code canvas. Visibility is enforced via `contentService.get`
 * (same `canView` gate as every other read), so a caller who cannot view the
 * object gets a NotFound (404-style) — existence is not leaked.
 *
 * SECURITY: the returned `code` is UNTRUSTED. The client passes it to the
 * CodeMirror editor (text only) or to the cross-origin `<ArtifactSandbox>` via
 * postMessage. It is never rendered on the app origin (§28.1).
 *
 * The version id is OPTIONAL: omit it to load the object's current head. When
 * provided, the version must belong to the object (enforced in
 * `versionService.getById`) so a viewer of object A cannot read a version of an
 * unrelated object B by id.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { contentService } from "@/lib/content";
import { versionService } from "@/lib/content/version-service";
import type { BodyFormat } from "@/lib/content";
import type { ActionState } from "@/types";
import { getOptionalRequester } from "./requester";

export interface ArtifactCodeResult {
  objectId: string;
  versionId: string;
  versionNumber: number;
  /**
   * The artifact body format. Will be "html" or "jsx" for artifacts (never
   * "markdown" — those are rejected before this result is constructed). Typed as
   * the full `BodyFormat` union so that future format additions do not require a
   * change here; `CodeEditor` and `ArtifactSandbox` accept `BodyFormat` already.
   */
  bodyFormat: BodyFormat;
  /** UNTRUSTED artifact source — sandbox/editor only, never app-origin render. */
  code: string;
}

export async function getArtifactCodeAction(
  idOrSlug: string,
  versionId?: string
): Promise<ActionState<ArtifactCodeResult>> {
  const requestId = generateRequestId();
  const timer = startTimer("getArtifactCodeAction");
  const log = createLogger({ requestId, action: "getArtifactCodeAction" });

  try {
    log.info("Action started: get artifact code", { idOrSlug, versionId: versionId ?? null });

    // Read access is bounded by canView (in contentService.get), not by the
    // authoring capability — a viewer can preview a visible artifact. A guest
    // (no session) can read `public` artifacts via canView.
    const requester = await getOptionalRequester(requestId);
    // get() enforces canView and 404s a non-viewable/absent object.
    const obj = await contentService.get(requester, idOrSlug);

    if (obj.kind !== "artifact") {
      // The canvas/loader is artifact-only; a document id here is a caller bug.
      throw ErrorFactories.validationFailed([
        { field: "idOrSlug", message: "Object is not an artifact" },
      ]);
    }

    // Resolve the target version: an explicit id (scoped to this object) or the
    // current head. getById returns null for a version of a different object.
    const version = versionId
      ? await versionService.getById(obj.id, versionId)
      : obj.version;
    if (!version) {
      throw ErrorFactories.dbRecordNotFound("content_versions", versionId ?? "(head)");
    }
    if (version.bodyFormat === "markdown") {
      throw ErrorFactories.validationFailed([
        { field: "versionId", message: "Version is not an artifact body" },
      ]);
    }

    const code = await versionService.loadArtifactCode(version);

    timer({ status: "success" });
    log.info("Artifact code loaded", {
      objectId: obj.id,
      versionId: version.id,
      versionNumber: version.versionNumber,
      bytes: code.length,
    });
    return createSuccess(
      {
        objectId: obj.id,
        versionId: version.id,
        versionNumber: version.versionNumber,
        bodyFormat: version.bodyFormat,
        code,
      },
      "Artifact code loaded"
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load artifact code", {
      context: "getArtifactCodeAction",
      requestId,
      operation: "getArtifactCodeAction",
    });
  }
}
