"use server"

import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger"
import {
  handleError,
  ErrorFactories,
  createSuccess,
} from "@/lib/error-utils"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery } from "@/lib/db/drizzle-client"
import { nexusMcpServers, nexusMcpConnections } from "@/lib/db/schema"
import { eq, sql, count } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import type { ActionState } from "@/types/actions-types"
import type { SelectNexusMcpServer, InsertNexusMcpServer } from "@/lib/db/types"

// ============================================
// Types
// ============================================

export interface McpServerWithStats extends SelectNexusMcpServer {
  connectionCount: number
}

export interface CreateMcpServerInput {
  name: string
  url: string
  transport: "http" | "stdio" | "websocket"
  authType: "none" | "oauth" | "api_key" | "jwt"
  credentialsKey?: string
  allowedUsers?: number[]
  maxConnections?: number
}

export interface UpdateMcpServerInput {
  id: string
  name?: string
  url?: string
  transport?: "http" | "stdio" | "websocket"
  authType?: "none" | "oauth" | "api_key" | "jwt"
  credentialsKey?: string | null
  allowedUsers?: number[]
  maxConnections?: number
}

export interface McpServerHealthInfo {
  serverId: string
  totalConnections: number
  connectedCount: number
  errorCount: number
  disconnectedCount: number
}

// Typed update payload — uses Drizzle's inferred insert type for type safety
type McpServerUpdate = Partial<
  Pick<
    InsertNexusMcpServer,
    | "name"
    | "url"
    | "transport"
    | "authType"
    | "credentialsKey"
    | "allowedUsers"
    | "maxConnections"
  >
>

// ============================================
// Validation
// ============================================

const VALID_TRANSPORTS = ["http", "stdio", "websocket"] as const
const VALID_AUTH_TYPES = ["none", "oauth", "api_key", "jwt"] as const
const MAX_CONNECTIONS_LIMIT = 100

/**
 * Block private/loopback IP ranges and non-HTTP(S)/WS(S) protocols.
 * Prevents SSRF when admin-configured URLs are later used to establish connections.
 */
function validateMcpUrl(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw ErrorFactories.invalidInput("url", "[redacted]", "Must be a valid URL")
  }

  const allowedProtocols =
    process.env.NODE_ENV === "production"
      ? ["https:", "wss:"]
      : ["https:", "wss:", "http:", "ws:"]

  if (!allowedProtocols.includes(parsed.protocol)) {
    throw ErrorFactories.invalidInput(
      "url",
      "[redacted]",
      `Protocol must be one of: ${allowedProtocols.join(", ")}`
    )
  }

  const privateRanges = [
    /^localhost$/i,
    /^0\.0\.0\.0$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./, // AWS EC2 instance metadata
    /^::1$/,
    /^fc/i,   // IPv6 ULA fc00::/7
    /^fd/i,   // IPv6 ULA fd00::/8
    /^fe80/i, // IPv6 link-local
  ]

  if (privateRanges.some((p) => p.test(parsed.hostname))) {
    throw ErrorFactories.invalidInput(
      "url",
      "[redacted]",
      "URL must not target internal network ranges"
    )
  }
}

function validateServerInput(
  input: Pick<Partial<CreateMcpServerInput>, "name" | "transport" | "authType" | "maxConnections">
): void {
  if (input.transport !== undefined) {
    if (!VALID_TRANSPORTS.includes(input.transport as typeof VALID_TRANSPORTS[number])) {
      throw ErrorFactories.invalidInput(
        "transport",
        input.transport,
        `Must be one of: ${VALID_TRANSPORTS.join(", ")}`
      )
    }
  }
  if (input.authType !== undefined) {
    if (!VALID_AUTH_TYPES.includes(input.authType as typeof VALID_AUTH_TYPES[number])) {
      throw ErrorFactories.invalidInput(
        "authType",
        input.authType,
        `Must be one of: ${VALID_AUTH_TYPES.join(", ")}`
      )
    }
  }
  if (input.name !== undefined) {
    const trimmed = input.name.trim()
    if (trimmed.length === 0 || trimmed.length > 255) {
      throw ErrorFactories.invalidInput("name", "[redacted]", "Name must be 1–255 characters")
    }
  }
  if (input.maxConnections !== undefined) {
    const n = input.maxConnections
    if (!Number.isInteger(n) || n < 1 || n > MAX_CONNECTIONS_LIMIT) {
      throw ErrorFactories.valueOutOfRange("maxConnections", n, 1, MAX_CONNECTIONS_LIMIT)
    }
  }
}

// ============================================
// List MCP Servers
// ============================================

export async function listMcpServers(): Promise<
  ActionState<McpServerWithStats[]>
> {
  const requestId = generateRequestId()
  const timer = startTimer("admin.listMcpServers")
  const log = createLogger({ requestId, action: "admin.listMcpServers" })

  try {
    log.info("Admin action started: Listing MCP servers")
    await requireRole("administrator")

    const servers = await executeQuery(
      (db) =>
        db
          .select({
            id: nexusMcpServers.id,
            name: nexusMcpServers.name,
            url: nexusMcpServers.url,
            transport: nexusMcpServers.transport,
            authType: nexusMcpServers.authType,
            credentialsKey: nexusMcpServers.credentialsKey,
            allowedUsers: nexusMcpServers.allowedUsers,
            maxConnections: nexusMcpServers.maxConnections,
            createdAt: nexusMcpServers.createdAt,
            updatedAt: nexusMcpServers.updatedAt,
            connectionCount: count(nexusMcpConnections.id),
          })
          .from(nexusMcpServers)
          .leftJoin(
            nexusMcpConnections,
            eq(nexusMcpServers.id, nexusMcpConnections.serverId)
          )
          .groupBy(nexusMcpServers.id)
          .orderBy(nexusMcpServers.name),
      "listMcpServers"
    )

    const result: McpServerWithStats[] = servers.map((s) => ({
      ...s,
      connectionCount: Number(s.connectionCount),
    }))

    timer({ status: "success", count: result.length })
    log.info("MCP servers listed", { count: result.length })
    return createSuccess(result, "Connectors loaded successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(
      error,
      "Failed to list connectors. Please try again.",
      {
        context: "admin.listMcpServers",
        requestId,
        operation: "admin.listMcpServers",
      }
    )
  }
}

// ============================================
// Create MCP Server
// ============================================

export async function createMcpServer(
  input: CreateMcpServerInput
): Promise<ActionState<SelectNexusMcpServer>> {
  const requestId = generateRequestId()
  const timer = startTimer("admin.createMcpServer")
  const log = createLogger({ requestId, action: "admin.createMcpServer" })

  try {
    await requireRole("administrator")

    // Log without credentialsKey — Secrets Manager key names should not appear in logs
    log.info("Admin action started: Creating MCP server", {
      name: input.name,
      url: input.url,
      transport: input.transport,
      authType: input.authType,
      hasCredentials: !!input.credentialsKey,
    })

    validateMcpUrl(input.url)
    validateServerInput(input)

    const [server] = await executeQuery(
      (db) =>
        db
          .insert(nexusMcpServers)
          .values({
            name: input.name,
            url: input.url,
            transport: input.transport,
            authType: input.authType,
            credentialsKey: input.credentialsKey ?? null,
            allowedUsers: input.allowedUsers ?? [],
            maxConnections: input.maxConnections ?? 10,
          })
          .returning(),
      "createMcpServer"
    )

    timer({ status: "success", serverId: server.id })
    log.info("MCP server created", { serverId: server.id, name: server.name })

    revalidatePath("/admin/connectors")
    return createSuccess(server, "Connector created successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(
      error,
      "Failed to create connector. Please try again.",
      {
        context: "admin.createMcpServer",
        requestId,
        operation: "admin.createMcpServer",
      }
    )
  }
}

// ============================================
// Update MCP Server
// ============================================

export async function updateMcpServer(
  input: UpdateMcpServerInput
): Promise<ActionState<SelectNexusMcpServer>> {
  const requestId = generateRequestId()
  const timer = startTimer("admin.updateMcpServer")
  const log = createLogger({ requestId, action: "admin.updateMcpServer" })

  try {
    // Log without credentialsKey — Secrets Manager key names should not appear in logs
    log.info("Admin action started: Updating MCP server", {
      serverId: input.id,
      name: input.name,
      url: input.url,
      transport: input.transport,
      authType: input.authType,
      hasCredentials: input.credentialsKey !== undefined
        ? input.credentialsKey !== null
        : undefined,
    })
    await requireRole("administrator")

    if (input.url !== undefined) validateMcpUrl(input.url)
    validateServerInput(input)

    // Typed update payload — avoids Record<string, unknown>
    const { id: _, ...fields } = input
    const updateData: McpServerUpdate = {}
    if (fields.name !== undefined) updateData.name = fields.name
    if (fields.url !== undefined) updateData.url = fields.url
    if (fields.transport !== undefined) updateData.transport = fields.transport
    if (fields.authType !== undefined) updateData.authType = fields.authType
    if (fields.credentialsKey !== undefined)
      updateData.credentialsKey = fields.credentialsKey
    if (fields.allowedUsers !== undefined)
      updateData.allowedUsers = fields.allowedUsers
    if (fields.maxConnections !== undefined)
      updateData.maxConnections = fields.maxConnections

    if (Object.keys(updateData).length === 0) {
      const [current] = await executeQuery(
        (db) =>
          db
            .select()
            .from(nexusMcpServers)
            .where(eq(nexusMcpServers.id, input.id))
            .limit(1),
        "updateMcpServer.noOp"
      )
      if (!current) {
        throw ErrorFactories.dbRecordNotFound("nexus_mcp_servers", input.id)
      }
      timer({ status: "noop" })
      log.info("Update called with no fields to change", { serverId: input.id })
      return createSuccess(current, "No changes to update")
    }

    const [server] = await executeQuery(
      (db) =>
        db
          .update(nexusMcpServers)
          .set(updateData)
          .where(eq(nexusMcpServers.id, input.id))
          .returning(),
      "updateMcpServer"
    )

    if (!server) {
      throw ErrorFactories.dbRecordNotFound("nexus_mcp_servers", input.id)
    }

    timer({ status: "success", serverId: server.id })
    log.info("MCP server updated", { serverId: server.id })

    revalidatePath("/admin/connectors")
    return createSuccess(server, "Connector updated successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(
      error,
      "Failed to update connector. Please try again.",
      {
        context: "admin.updateMcpServer",
        requestId,
        operation: "admin.updateMcpServer",
        metadata: { serverId: input.id },
      }
    )
  }
}

// ============================================
// Delete MCP Server
// ============================================

export async function deleteMcpServer(
  id: string
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("admin.deleteMcpServer")
  const log = createLogger({ requestId, action: "admin.deleteMcpServer" })

  try {
    log.info("Admin action started: Deleting MCP server", { serverId: id })
    await requireRole("administrator")

    const result = await executeQuery(
      (db) =>
        db
          .delete(nexusMcpServers)
          .where(eq(nexusMcpServers.id, id))
          .returning({ id: nexusMcpServers.id }),
      "deleteMcpServer"
    )

    if (result.length === 0) {
      throw ErrorFactories.dbRecordNotFound("nexus_mcp_servers", id)
    }

    timer({ status: "success", serverId: id })
    log.info("MCP server deleted", { serverId: id })

    revalidatePath("/admin/connectors")
    return createSuccess(undefined, "Connector deleted successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(
      error,
      "Failed to delete connector. Please try again.",
      {
        context: "admin.deleteMcpServer",
        requestId,
        operation: "admin.deleteMcpServer",
        metadata: { serverId: id },
      }
    )
  }
}

// ============================================
// Get MCP Server Health
// ============================================

export async function getMcpServerHealth(
  serverId: string
): Promise<ActionState<McpServerHealthInfo>> {
  const requestId = generateRequestId()
  const timer = startTimer("admin.getMcpServerHealth")
  const log = createLogger({ requestId, action: "admin.getMcpServerHealth" })

  try {
    log.debug("Admin action started: Getting MCP server health", { serverId })
    await requireRole("administrator")

    // Single LEFT JOIN query: existence check + aggregation in one round-trip.
    // No rows returned means server doesn't exist; one row with all-zero counts
    // means server exists but has no connections.
    const [row] = await executeQuery(
      (db) =>
        db
          .select({
            totalConnections: count(nexusMcpConnections.id),
            connectedCount: count(
              sql`CASE WHEN ${nexusMcpConnections.status} = 'connected' THEN 1 END`
            ),
            errorCount: count(
              sql`CASE WHEN ${nexusMcpConnections.status} = 'error' THEN 1 END`
            ),
            disconnectedCount: count(
              sql`CASE WHEN ${nexusMcpConnections.status} = 'disconnected' THEN 1 END`
            ),
          })
          .from(nexusMcpServers)
          .leftJoin(
            nexusMcpConnections,
            eq(nexusMcpServers.id, nexusMcpConnections.serverId)
          )
          .where(eq(nexusMcpServers.id, serverId))
          .groupBy(nexusMcpServers.id),
      "getMcpServerHealth"
    )

    if (!row) {
      throw ErrorFactories.dbRecordNotFound("nexus_mcp_servers", serverId)
    }

    const result: McpServerHealthInfo = {
      serverId,
      totalConnections: Number(row.totalConnections),
      connectedCount: Number(row.connectedCount),
      errorCount: Number(row.errorCount),
      disconnectedCount: Number(row.disconnectedCount),
    }

    timer({ status: "success" })
    log.debug("MCP server health retrieved", { serverId, total: result.totalConnections })
    return createSuccess(result, "Health data loaded")
  } catch (error) {
    timer({ status: "error" })
    return handleError(
      error,
      "Failed to get connector health. Please try again.",
      {
        context: "admin.getMcpServerHealth",
        requestId,
        operation: "admin.getMcpServerHealth",
        metadata: { serverId },
      }
    )
  }
}
