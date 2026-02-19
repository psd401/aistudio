"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { getServerSession } from "@/lib/auth/server-session"
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"
import { executeQuery } from "@/lib/db/drizzle-client"
import { nexusMcpServers } from "@/lib/db/schema"
import { or, sql } from "drizzle-orm"
import type { ActionState } from "@/types/actions-types"

export interface AvailableMcpServer {
  id: string
  name: string
  url: string
  transport: string
}

/**
 * List MCP servers available to the current user.
 * A server is available when allowedUsers is empty (open to all)
 * or the current user's integer ID is in allowedUsers.
 */
export async function listAvailableMcpServers(): Promise<
  ActionState<AvailableMcpServer[]>
> {
  const requestId = generateRequestId()
  const timer = startTimer("nexus.listAvailableMcpServers")
  const log = createLogger({ requestId, action: "nexus.listAvailableMcpServers" })

  try {
    const session = await getServerSession()
    if (!session) {
      throw ErrorFactories.authNoSession()
    }

    const currentUser = await getCurrentUserAction()
    if (!currentUser.isSuccess) {
      throw ErrorFactories.authNoSession()
    }

    const userId = currentUser.data.user.id

    log.debug("Fetching available MCP servers", { userId })

    const servers = await executeQuery(
      (db) =>
        db
          .select({
            id: nexusMcpServers.id,
            name: nexusMcpServers.name,
            url: nexusMcpServers.url,
            transport: nexusMcpServers.transport,
          })
          .from(nexusMcpServers)
          .where(
            or(
              // Empty allowedUsers array → available to everyone
              sql`array_length(${nexusMcpServers.allowedUsers}, 1) IS NULL`,
              // User is explicitly listed
              sql`${userId} = ANY(${nexusMcpServers.allowedUsers})`
            )
          )
          .orderBy(nexusMcpServers.name),
      "nexus.listAvailableMcpServers"
    )

    timer({ status: "success", count: servers.length })
    log.debug("Available MCP servers fetched", { count: servers.length })
    return createSuccess(servers, "MCP servers loaded")
  } catch (error) {
    timer({ status: "error" })
    return handleError(
      error,
      "Failed to load MCP servers.",
      {
        context: "nexus.listAvailableMcpServers",
        requestId,
        operation: "nexus.listAvailableMcpServers",
      }
    )
  }
}
