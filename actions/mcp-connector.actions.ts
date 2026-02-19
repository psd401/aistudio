"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
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

/** Token expiry buffer — proactively mark tokens expiring within 60 seconds as expired */
const TOKEN_EXPIRY_BUFFER_MS = 60_000

/** Valid authType values — mirrors CHECK constraint in 028-nexus-schema.sql */
const VALID_AUTH_TYPES = new Set<McpAuthType>(["api_key", "oauth", "jwt", "none"])

/**
 * Connector with connection status for the current user.
 * tokenExpiresAt is intentionally omitted — the UI only needs the derived status.
 */
export interface ConnectorWithStatus {
  id: string
  name: string
  authType: McpAuthType
  status: McpConnectionStatus
}

/**
 * Fetches available MCP connectors for the current user with their connection status.
 *
 * ⚠️ SYNC: Access rules here MUST match connector-service.ts assertUserAccess().
 * If you change access logic here, update connector-service.ts (and vice versa).
 *
 * Access rules:
 *   - If allowedUsers is non-empty, user must be in the list.
 *   - Otherwise, user must have "administrator" or "staff" role.
 *
 * Combines connector listing + per-user token status in a single JOIN.
 */
export async function getConnectorsWithStatus(): Promise<ActionState<ConnectorWithStatus[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getConnectorsWithStatus")
  const log = createLogger({ requestId, action: "getConnectorsWithStatus" })

  try {
    log.info("Fetching connectors with status")

    const session = await getServerSession()
    if (!session?.sub) {
      log.warn("Unauthorized")
      throw ErrorFactories.authNoSession()
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
      log.warn("User not found in DB")
      throw ErrorFactories.authNoSession()
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
    // Access control: empty allowedUsers[] = open to admin/staff; non-empty = explicit allow list.
    // Non-admin/non-staff users can only see connectors where they are explicitly listed.
    const hasDefaultAccess =
      userRoleNames.includes("administrator") || userRoleNames.includes("staff")

    const conditions = [
      // User is explicitly listed in the allow list
      sql`${userId} = ANY(${nexusMcpServers.allowedUsers})`,
    ]
    if (hasDefaultAccess) {
      // Connectors with empty allow list are open to admin/staff
      conditions.push(
        sql`coalesce(cardinality(${nexusMcpServers.allowedUsers}), 0) = 0`
      )
    }

    // Single JOIN — connector rows + user token status in one round trip
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

      // Connectors with authType "none" are always connected (no token needed)
      if (row.authType === "none") {
        status = "connected"
      }

      // Runtime validation — DB varchar has no enum enforcement at the ORM level
      const rawAuthType = row.authType as string
      let authType: McpAuthType
      if (VALID_AUTH_TYPES.has(rawAuthType as McpAuthType)) {
        authType = rawAuthType as McpAuthType
      } else {
        log.warn("Unknown authType, falling back to 'none'", { serverId: row.id, authType: rawAuthType })
        authType = "none"
      }

      return { id: row.id, name: row.name, authType, status }
    })

    timer({ status: "success", count: connectors.length })
    log.info("Connectors fetched", { count: connectors.length })

    return createSuccess(connectors, "Connectors fetched")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch connectors", {
      context: "getConnectorsWithStatus",
      requestId,
      operation: "getConnectorsWithStatus",
    })
  }
}
