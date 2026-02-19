"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { getServerSession } from "@/lib/auth/server-session"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, and, or, sql } from "drizzle-orm"
import {
  nexusMcpServers,
  nexusMcpUserTokens,
  users,
  userRoles,
  roles,
} from "@/lib/db/schema"
import type { ActionState } from "@/types/actions-types"
import type { McpAuthType, McpConnectionStatus } from "@/lib/mcp/connector-types"

const log = createLogger({ action: "mcp-connector-actions" })

/** Token expiry buffer — proactively mark tokens expiring within 60 seconds as expired */
const TOKEN_EXPIRY_BUFFER_MS = 60_000

/** Connector with connection status for the current user */
export interface ConnectorWithStatus {
  id: string
  name: string
  authType: McpAuthType
  status: McpConnectionStatus
  tokenExpiresAt: string | null
}

/**
 * Fetches available MCP connectors for the current user with their connection status.
 * Combines connector listing + per-user token status in a single server action.
 */
export async function getConnectorsWithStatus(): Promise<ActionState<ConnectorWithStatus[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getConnectorsWithStatus")

  try {
    const session = await getServerSession()
    if (!session?.sub) {
      log.warn("Unauthorized", { requestId })
      return { isSuccess: false, message: "Not authenticated" }
    }

    // Look up numeric user ID from cognito sub
    const userRows = await executeQuery(
      (db) =>
        db.select({ id: users.id })
          .from(users)
          .where(eq(users.cognitoSub, session.sub))
          .limit(1),
      "getConnectorsWithStatus:userId"
    )

    if (userRows.length === 0) {
      log.warn("User not found", { requestId })
      return { isSuccess: false, message: "User not found" }
    }

    const userId = userRows[0].id

    // Get user role names for access control
    const roleRows = await executeQuery(
      (db) =>
        db.select({ name: roles.name })
          .from(userRoles)
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .where(eq(userRoles.userId, userId)),
      "getConnectorsWithStatus:roles"
    )

    const userRoleNames = roleRows.map((r) => r.name)
    const hasDefaultAccess =
      userRoleNames.includes("administrator") || userRoleNames.includes("staff")

    // Fetch accessible connectors with LEFT JOIN on user tokens for status
    const conditions = [
      sql`${userId} = ANY(${nexusMcpServers.allowedUsers})`,
    ]
    if (hasDefaultAccess) {
      conditions.push(
        sql`coalesce(cardinality(${nexusMcpServers.allowedUsers}), 0) = 0`
      )
    }

    const rows = await executeQuery(
      (db) =>
        db.select({
          id: nexusMcpServers.id,
          name: nexusMcpServers.name,
          authType: nexusMcpServers.authType,
          tokenExpiresAt: nexusMcpUserTokens.tokenExpiresAt,
          hasToken: sql<boolean>`${nexusMcpUserTokens.id} IS NOT NULL`,
        })
          .from(nexusMcpServers)
          .leftJoin(
            nexusMcpUserTokens,
            and(
              eq(nexusMcpUserTokens.serverId, nexusMcpServers.id),
              eq(nexusMcpUserTokens.userId, userId)
            )
          )
          .where(or(...conditions)),
      "getConnectorsWithStatus:connectors"
    )

    const bufferThreshold = new Date(Date.now() + TOKEN_EXPIRY_BUFFER_MS)

    const connectors: ConnectorWithStatus[] = rows.map((row) => {
      let status: McpConnectionStatus = "no_token"
      if (row.hasToken) {
        status =
          row.tokenExpiresAt && row.tokenExpiresAt < bufferThreshold
            ? "token_expired"
            : "connected"
      }

      // Connectors with authType "none" are always connected
      if (row.authType === "none") {
        status = "connected"
      }

      return {
        id: row.id,
        name: row.name,
        authType: row.authType as McpAuthType,
        status,
        tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
      }
    })

    timer({ status: "success", count: connectors.length })
    log.info("Connectors fetched", { requestId, count: connectors.length })

    return {
      isSuccess: true,
      message: "Connectors fetched",
      data: connectors,
    }
  } catch (error) {
    timer({ status: "error" })
    log.error("Failed to fetch connectors", {
      requestId,
      error: String(error),
    })
    return {
      isSuccess: false,
      message: "Failed to fetch connectors",
    }
  }
}
