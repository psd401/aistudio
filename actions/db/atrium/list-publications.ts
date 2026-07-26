"use server"

/**
 * Atrium list-publications server action (#1336)
 *
 * Read-only window over an object's LIVE `content_publications` rows, so the
 * authoring surfaces can finally reflect publication state instead of guessing:
 *
 * - `PublishMenu` marks each destination LIVE and disables "Unpublish" for a
 *   destination that was never published (it previously offered both verbs for
 *   every destination, on never-published drafts included — #1336 B8).
 * - `VisibilityChip` warns when an object is set to Public but has no live
 *   `public_web` publication, which is exactly the state where `/p/{slug}`
 *   404s (#1336 C1).
 * - `ArtifactTopbarActions` resolves a Share URL that actually resolves,
 *   rather than assuming visibility alone implies a public page (#1336 C4).
 *
 * Existence is masked in the service (`canView` → 404, never 403), so this
 * cannot be used to probe for private object ids. It is NOT capability-gated:
 * like `listContentAction`, reading where something is published is bounded by
 * the same view permission as reading the object itself — only WRITE actions
 * carry the `atrium-content` gate.
 */

import {
  createLogger,
  generateRequestId,
  sanitizeForLogging,
  startTimer,
} from "@/lib/logger";
import { createSuccess, handleError } from "@/lib/error-utils";
import { contentService } from "@/lib/content/content-service";
import {
  publishService,
  type LivePublicationDTO,
} from "@/lib/content/publish-service";
import { NotFoundError } from "@/lib/content/errors";
import type { ActionState } from "@/types";
import { getOptionalRequester } from "./requester";

export async function listPublicationsAction(
  idOrSlug: string
): Promise<ActionState<LivePublicationDTO[]>> {
  const requestId = generateRequestId();
  const timer = startTimer("listPublicationsAction");
  const log = createLogger({ requestId, action: "listPublicationsAction" });

  try {
    log.info("Action started: list publications", {
      idOrSlug: sanitizeForLogging(idOrSlug),
    });

    const requester = await getOptionalRequester(requestId);
    const obj = await contentService.loadByIdOrSlug(idOrSlug);
    // Same 404-masking as the service: an unknown id and a non-viewable one are
    // indistinguishable to the caller.
    if (!obj) throw new NotFoundError("Content not found", { idOrSlug });

    const publications = await publishService.listLive(requester, obj.id);

    timer({ status: "success" });
    log.info("Publications listed", {
      objectId: obj.id,
      count: publications.length,
    });
    return createSuccess(publications, "Publications listed");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load publication state", {
      context: "listPublicationsAction",
      requestId,
      operation: "listPublicationsAction",
    });
  }
}
