"use server"

/**
 * Atrium resolve-artifact-embed server action (Epic #1059 Meridian slice D)
 *
 * Resolves an embedded artifact for the EDITOR's live NodeView
 * (`ArtifactEmbedNodeView`): given an artifact id, returns the title, reader href,
 * sandbox render URL, and UNTRUSTED code — but ONLY when the current viewer may see
 * the artifact. Visibility is enforced by `resolveEmbedForReader` (the same
 * `canView` gate as every other read), so a caller who cannot view the artifact
 * gets `available: false` with no title or code — existence is not leaked.
 *
 * SECURITY: `code` is UNTRUSTED artifact source. The client passes it only to the
 * cross-origin `<ArtifactSandbox>` (§28.1), never to app-origin render.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError } from "@/lib/error-utils";
import {
  resolveEmbedForReader,
  type ResolvedEmbed,
} from "@/lib/content/embed-resolver";
import type { ActionState } from "@/types";
import { getOptionalRequester } from "./requester";

export async function resolveArtifactEmbedAction(
  artifactId: string
): Promise<ActionState<ResolvedEmbed>> {
  const requestId = generateRequestId();
  const timer = startTimer("resolveArtifactEmbedAction");
  const log = createLogger({ requestId, action: "resolveArtifactEmbedAction" });

  try {
    log.info("Action started: resolve artifact embed", { artifactId });

    // The editor NodeView is an internal, logged-in surface; resolve the session
    // principal and gate on canView (the resolver 404-masks a non-viewable or
    // non-existent artifact into `available: false`).
    const requester = await getOptionalRequester(requestId);
    const resolved = await resolveEmbedForReader(artifactId, {
      audience: "internal",
      requester,
    });

    timer({ status: "success" });
    log.info("Artifact embed resolved", { artifactId, available: resolved.available });
    return createSuccess(resolved, "Artifact embed resolved");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to resolve artifact embed", {
      context: "resolveArtifactEmbedAction",
      requestId,
      operation: "resolveArtifactEmbedAction",
    });
  }
}
