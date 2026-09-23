/**
 * Resolve the object open in the workspace panel (`?workspace=<id|slug>`) into
 * the routing view of it defined by `workspace-routing-contract.ts` (#1786).
 *
 * This is a ROUTING INPUT ONLY. It confers no access: the tools the router
 * attaches are still the connector's own, gated by the connector's own auth, and
 * the workspace content tools are built separately by
 * `lib/nexus/workspace-chat-tools.ts` against the same `contentService` gates.
 * Resolution goes through `contentService.get`, which 404-masks an object the
 * session user cannot view, so a spoofed `?workspace=` id yields null.
 *
 * Never throws: an unknown, unviewable or unresolvable workspace id resolves to
 * null and the turn routes exactly as it does today. A bad `?workspace=` must
 * never break chat (same contract as `buildWorkspaceChatTools`).
 */

import { contentService } from "@/lib/content/content-service";
import { canEdit } from "@/lib/content/helpers";
import { requesterForUserId } from "@/lib/content/requester-from-auth";
import { createLogger } from "@/lib/logger";
import type { NexusWorkspaceRoutingContext } from "./workspace-routing-contract";

/**
 * Resolve the open workspace object, or null when there is nothing viewable to
 * resolve.
 */
export async function resolveWorkspaceRoutingContext(params: {
  workspaceIdOrSlug: string | undefined;
  userId: number;
  requestId: string;
}): Promise<NexusWorkspaceRoutingContext | null> {
  const { workspaceIdOrSlug, userId, requestId } = params;
  if (!workspaceIdOrSlug) return null;
  const log = createLogger({ requestId, module: "nexus-workspace-routing" });

  try {
    const req = await requesterForUserId(userId);
    if (!req) return null;
    // 404-masks an object this user cannot view, so this also gates the id.
    const obj = await contentService.get(req, workspaceIdOrSlug);
    return {
      objectId: obj.id,
      kind: obj.kind as "document" | "artifact",
      editable: canEdit(req, obj.ownerUserId),
      dataAccess: obj.dataAccess,
    };
  } catch (error) {
    // Routing must survive a bad/unviewable workspace id — info, not warn, for
    // the same reason `buildWorkspaceChatTools` logs at info here.
    log.info("No viewable workspace object for routing", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
