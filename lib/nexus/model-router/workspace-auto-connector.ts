/**
 * What the model router WILL auto-attach for a turn sent with a given workspace
 * object open — the pre-turn preview of that decision (#1786).
 *
 * It lives beside `router.ts` on purpose. The composer's Connect popover has to
 * answer "is PSD Data on for this workspace?" BEFORE any turn is sent, and the
 * only wrong answer is one that disagrees with what the router then does. Both
 * sides therefore share the predicate (`workspaceNeedsPsdData`), the connector
 * identity (`resolvePsdDataConnectorId`) and the runtime-mode gate, and
 * `router.test.ts` pins that they agree.
 *
 * Deliberately takes an ALREADY-RESOLVED workspace rather than an id: that keeps
 * this module free of the content service, so the router's own tests can build a
 * workspace as a plain object.
 */

import { getNexusRouterConfig } from "./config"
import { resolvePsdDataConnectorId } from "./psd-data-connector"
import {
  workspaceNeedsPsdData,
  type NexusWorkspaceRoutingContext,
} from "../workspace-routing-contract"
import { createLogger } from "@/lib/logger"

const log = createLogger({ module: "nexus-workspace-auto-connector" })

/**
 * The connector ids the router will attach on its own for this workspace.
 *
 * Empty unless routing is `active`: in `shadow` and `off` the turn's connectors
 * are exactly what the user switched on, so there is nothing to preview.
 *
 * Never throws — a popover label must not be able to break the composer.
 */
export async function previewWorkspaceAutoConnectorIds(
  workspace: NexusWorkspaceRoutingContext | null | undefined
): Promise<string[]> {
  if (!workspaceNeedsPsdData(workspace)) return []
  try {
    const { config, mode } = await getNexusRouterConfig()
    if (mode !== "active") return []
    const connectorId = await resolvePsdDataConnectorId(config)
    return connectorId ? [connectorId] : []
  } catch (error) {
    log.info("Could not preview the workspace auto-attached connectors", {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
