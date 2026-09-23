"use server"

import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
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
import { getNexusRouterConfig } from "@/lib/nexus/model-router/config"
import { resolvePsdDataConnectorId } from "@/lib/nexus/model-router/psd-data-connector"
import { workspaceNeedsPsdData } from "@/lib/nexus/workspace-routing-contract"
import { resolveWorkspaceRoutingContext } from "@/lib/nexus/workspace-routing-context"

/** Token expiry buffer — proactively mark tokens expiring within 60 seconds as expired */
const TOKEN_EXPIRY_BUFFER_MS = 60_000

/** Valid authType values — mirrors CHECK constraint (updated in 060-mcp-cognito-passthrough-auth.sql) */
const VALID_AUTH_TYPES = new Set<McpAuthType>(["api_key", "oauth", "jwt", "none", "cognito_passthrough"])

/**
 * Connector with connection status for the current user.
 * tokenExpiresAt is intentionally omitted — the UI only needs the derived status.
 */
export interface ConnectorWithStatus {
  id: string
  name: string
  authType: McpAuthType
  status: McpConnectionStatus
  /**
   * #1786: the model router will attach this connector to every turn sent while
   * the caller's workspace object is open, whatever the user's own toggle says.
   * The popover renders it as on and explains why, instead of showing an off
   * toggle beside a connector the model is actually using. Always false when no
   * `workspaceId` was passed.
   */
  autoAttachedForWorkspace: boolean
}

/**
 * Which connector the model router will attach on its own for the open
 * workspace object, or null when it will not attach one (#1786).
 *
 * Deliberately built from the SAME three pieces the chat route uses — the
 * workspace resolver, `workspaceNeedsPsdData`, and `resolvePsdDataConnectorId`
 * — so the popover cannot claim something the router will not do. Re-deriving
 * "which connector is PSD Data" by name here would be exactly the drift
 * `psd-data-connector.ts` exists to prevent.
 *
 * Only `active` routing attaches connectors: in `shadow` and `off` the turn's
 * connectors are exactly what the user switched on, so the popover makes no
 * claim. Never throws — a Connect popover must open even when this lookup
 * cannot answer.
 */
async function resolveWorkspaceAutoAttachedConnectorId(params: {
  workspaceId?: string
  userId: number
  requestId: string
}): Promise<string | null> {
  if (!params.workspaceId) return null
  const log = createLogger({ requestId: params.requestId, action: "workspaceAutoConnector" })
  try {
    const { config, mode } = await getNexusRouterConfig()
    if (mode !== "active") return null
    const workspace = await resolveWorkspaceRoutingContext({
      workspaceIdOrSlug: params.workspaceId,
      userId: params.userId,
      requestId: params.requestId,
    })
    if (!workspaceNeedsPsdData(workspace)) return null
    return await resolvePsdDataConnectorId(config)
  } catch (error) {
    log.info("Could not determine the workspace auto-attached connector", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Fetches available MCP connectors for the current user with their connection status.
 *
 * ⚠️ SYNC: Access rules here MUST match connector-service.ts requireUserAccess().
 * If you change access logic here, update connector-service.ts (and vice versa).
 *
 * Access rules:
 *   - If allowedUsers is non-empty, user must be in the list.
 *   - Otherwise, user must have "administrator" or "staff" role.
 *
 * Combines connector listing + per-user token status in a single JOIN.
 */
export async function getConnectorsWithStatus(
  params: { workspaceId?: string } = {}
): Promise<ActionState<ConnectorWithStatus[]>> {
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
    const autoAttachedId = await resolveWorkspaceAutoAttachedConnectorId({
      workspaceId: params.workspaceId,
      userId,
      requestId,
    })

    const connectors: ConnectorWithStatus[] = rows.map((row) => {
      let status: McpConnectionStatus = "no_token"
      if (row.hasToken) {
        status =
          row.tokenExpiresAt && row.tokenExpiresAt < bufferThreshold
            ? "token_expired"
            : "connected"
      }

      // Connectors with authType "none" or "cognito_passthrough" are always connected
      // (no per-user token storage needed — cognito_passthrough uses the session idToken)
      if (row.authType === "none" || row.authType === "cognito_passthrough") {
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

      return {
        id: row.id,
        name: row.name,
        authType,
        status,
        autoAttachedForWorkspace: autoAttachedId !== null && row.id === autoAttachedId,
      }
    })

    timer({ status: "success", count: connectors.length })
    log.info("Connectors fetched", sanitizeForLogging({ count: connectors.length, userId }))

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
