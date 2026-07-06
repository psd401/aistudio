"use server";

/**
 * Nexus workspace-panel loader (Epic #1059, spec §17)
 *
 * The ONE server round-trip behind the Nexus WorkspacePanel: resolves everything
 * the panel needs to mount the kind-specific Atrium editor beside the chat —
 * object metadata, the caller's integer user id (the collaborative editor stamps
 * it on edits), the canEdit hint, and (for artifacts) the server-resolved sandbox
 * render URL that `ArtifactCanvas` requires.
 *
 * Mirrors the standalone edit page's gate EXACTLY (`app/(protected)/atrium/[id]/
 * edit/page.tsx`): requester (401) → existence (404) → canView (404-mask; a
 * non-viewable object is indistinguishable from an absent one). Edit permission
 * is enforced AGAIN server-side by every write the editors perform — `canEdit`
 * here is a UI hint only.
 */

import { generateRequestId, startTimer, createLogger } from "@/lib/logger";
import { createSuccess, handleError, ErrorFactories } from "@/lib/error-utils";
import { getUserRequester } from "./requester";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { canEdit as canEditOf } from "@/lib/content/helpers";
import { getArtifactSandboxRenderUrl } from "@/lib/content/artifact-sandbox-config";
import { NotFoundError } from "@/lib/content/errors";
import type { ActionState } from "@/types";

/** Everything the WorkspacePanel needs to mount the right editor. */
export interface WorkspacePanelData {
  id: string;
  slug: string;
  title: string;
  kind: "document" | "artifact";
  /** The signed-in user's integer id (stamped on collaborative edits). */
  userId: number;
  /** UI hint only — every write re-checks server-side. */
  canEdit: boolean;
  /** Artifact sandbox render URL (null for documents / unconfigured sandbox). */
  sandboxSrc: string | null;
}

export async function loadWorkspacePanelAction(
  idOrSlug: string
): Promise<ActionState<WorkspacePanelData>> {
  const requestId = generateRequestId();
  const timer = startTimer("loadWorkspacePanelAction");
  const log = createLogger({ requestId, action: "loadWorkspacePanelAction" });

  try {
    if (!idOrSlug || idOrSlug.length > 200) {
      throw ErrorFactories.missingRequiredField("idOrSlug");
    }

    const requester = await getUserRequester(requestId);
    const obj = await contentService.loadByIdOrSlug(idOrSlug);
    if (!obj) throw new NotFoundError("Content not found", { idOrSlug });

    const viewable = await visibilityService.canView(requester, {
      id: obj.id,
      ownerUserId: obj.ownerUserId,
      visibilityLevel: obj.visibilityLevel,
    });
    // Existence-mask: a non-viewable object 404s exactly like an absent one.
    if (!viewable) throw new NotFoundError("Content not found", { idOrSlug });

    if (requester.kind !== "user" || requester.userId == null) {
      // The panel is a browser surface; a non-user requester cannot occur via a
      // server action, but fail closed rather than mint a bogus editor identity.
      throw ErrorFactories.authNoSession();
    }

    timer({ status: "success" });
    log.info("Workspace panel loaded", { objectId: obj.id, kind: obj.kind });
    return createSuccess(
      {
        id: obj.id,
        slug: obj.slug,
        title: obj.title,
        kind: obj.kind,
        userId: requester.userId,
        canEdit: canEditOf(requester, obj.ownerUserId),
        sandboxSrc:
          obj.kind === "artifact" ? getArtifactSandboxRenderUrl() : null,
      },
      "Workspace loaded"
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load the workspace item", {
      context: "loadWorkspacePanelAction",
      requestId,
      operation: "loadWorkspacePanelAction",
    });
  }
}
