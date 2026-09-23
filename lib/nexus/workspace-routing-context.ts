/**
 * What the Nexus model router needs to know about the object open in the
 * workspace panel (`?workspace=<id|slug>`), resolved BEFORE the turn is routed.
 *
 * Why this exists (#1786): the router attaches the PSD Data connector per
 * MESSAGE, only when that one message classifies as `psd-data`. While a live
 * dashboard is open beside the chat, a normal follow-up ("add a school
 * dropdown", "the chart is empty, fix it") classifies as `general`, so the turn
 * loses `list_available_tables` / `inspect_table_schema` / `query_data` — and
 * the model then writes SQL against GUESSED column names, reports success, and
 * silently breaks a working dashboard. The open artifact is the missing routing
 * input: editing an artifact is data work regardless of how the sentence reads.
 *
 * This is a ROUTING INPUT ONLY. It confers no access: the tools the router
 * attaches are still the connector's own, gated by the connector's own auth, and
 * the workspace content tools are built separately by
 * `lib/nexus/workspace-chat-tools.ts` against the same `contentService` gates.
 * Resolution here goes through `contentService.get`, which 404-masks an object
 * the session user cannot view, so a spoofed `?workspace=` id yields null.
 *
 * Never throws: an unknown, unviewable or unresolvable workspace id resolves to
 * null and the turn routes exactly as it does today. A bad `?workspace=` must
 * never break chat (same contract as `buildWorkspaceChatTools`).
 */

import { contentService } from "@/lib/content/content-service";
import { canEdit } from "@/lib/content/helpers";
import { requesterForUserId } from "@/lib/content/requester-from-auth";
import type { ContentDataAccess } from "@/lib/content/types";
import { createLogger } from "@/lib/logger";

export interface NexusWorkspaceRoutingContext {
  /** Resolved content object id (never the caller's raw slug). */
  objectId: string;
  kind: "document" | "artifact";
  /** Whether the SESSION user may edit it — a read-only viewer cannot author. */
  editable: boolean;
  /** Artifacts only: the sandbox data-bridge mode the artifact is pinned to. */
  dataAccess: ContentDataAccess;
}

/**
 * Appended to the workspace system-prompt fragment when an editable artifact is
 * open but the PSD Data tools could NOT be attached this turn (#1786) — the
 * connector is unconfigured, unavailable, or the router is in shadow mode.
 *
 * Model-facing text, not user copy. Without it the model reads
 * `ATRIUM_DATA_AUTHORING_GUIDANCE` ("Explore the data with a couple of
 * queries"), finds no query tool, and invents column names anyway.
 */
export const WORKSPACE_PSD_DATA_UNAVAILABLE_GUIDANCE =
  " PSD DATA TOOLS ARE NOT AVAILABLE ON THIS TURN: you have no way to list tables," +
  " inspect a schema, or run a query. Do NOT guess table or column names and do NOT" +
  " write or edit SQL you cannot verify. Keep any SQL already in the artifact exactly" +
  " as it is, make only the changes you can make without knowing the schema, and tell" +
  " the user plainly that you could not verify the data schema and that they should" +
  " switch PSD Data on in the Connect menu for data changes.";

/**
 * Resolve the open workspace object into the router's view of it, or null when
 * there is nothing viewable to resolve.
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
