import { eq } from "drizzle-orm"
import { executeQuery } from "@/lib/db/drizzle-client"
import { nexusMcpServers } from "@/lib/db/schema"
import type { NexusRouterConfig } from "./types"

/**
 * Resolve "the PSD Data MCP server" from the Nexus router configuration.
 *
 * ONE definition of that identity, deliberately: the Nexus chat router
 * (`routeNexusRequest`) and the Atrium artifact query bridge
 * (`actions/db/atrium/artifact-query.ts`, #1705) must agree on which connector
 * row is the district data server, or an administrator repointing the connector
 * would silently leave one surface talking to the old one.
 *
 * Resolution order matches the admin UI (`nexus-router-settings-card`): an
 * explicitly configured connector id wins; otherwise the connector whose name
 * normalizes to `specialists.psdDataConnectorName` (default `psd-data`). Returns
 * null when neither matches — every caller must treat that as "unavailable" and
 * fail closed rather than falling back to any other connector.
 */
export async function resolvePsdDataConnectorId(
  config: NexusRouterConfig
): Promise<string | null> {
  const configuredId = config.specialists.psdDataConnectorId
  if (configuredId) {
    const [row] = await executeQuery(
      db => db.select({ id: nexusMcpServers.id }).from(nexusMcpServers)
        .where(eq(nexusMcpServers.id, configuredId)).limit(1),
      "resolvePsdDataConnectorById"
    )
    return row?.id ?? null
  }
  const rows = await executeQuery(
    db => db.select({ id: nexusMcpServers.id, name: nexusMcpServers.name }).from(nexusMcpServers),
    "resolvePsdDataConnectorByName"
  )
  const normalize = (value: string) => value.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
  const configuredName = normalize(config.specialists.psdDataConnectorName)
  return rows.find(row => normalize(row.name) === configuredName)?.id ?? null
}
