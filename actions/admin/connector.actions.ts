"use server"

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
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
import type { SelectNexusMcpServer } from "@/lib/db/types"

// ============================================
// Types
// ============================================

export interface McpServerWithStats extends SelectNexusMcpServer {
  connectionCount: number
}

export interface CreateMcpServerInput {
  name: string
  url: string
  transport: string
  authType: string
  credentialsKey?: string
  allowedUsers?: number[]
  maxConnections?: number
}

export interface UpdateMcpServerInput {
  id: string
  name?: string
  url?: string
  transport?: string
  authType?: string
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
    log.info("Admin action started: Creating MCP server", {
      params: sanitizeForLogging(input),
    })
    await requireRole("administrator")

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
    log.info("Admin action started: Updating MCP server", {
      serverId: input.id,
      params: sanitizeForLogging(input),
    })
    await requireRole("administrator")

    const updateData: Record<string, unknown> = {}
    if (input.name !== undefined) updateData.name = input.name
    if (input.url !== undefined) updateData.url = input.url
    if (input.transport !== undefined) updateData.transport = input.transport
    if (input.authType !== undefined) updateData.authType = input.authType
    if (input.credentialsKey !== undefined)
      updateData.credentialsKey = input.credentialsKey
    if (input.allowedUsers !== undefined)
      updateData.allowedUsers = input.allowedUsers
    if (input.maxConnections !== undefined)
      updateData.maxConnections = input.maxConnections

    if (Object.keys(updateData).length === 0) {
      return { isSuccess: false, message: "No fields to update" }
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
    log.info("Admin action started: Getting MCP server health", { serverId })
    await requireRole("administrator")

    const stats = await executeQuery(
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
          .from(nexusMcpConnections)
          .where(eq(nexusMcpConnections.serverId, serverId)),
      "getMcpServerHealth"
    )

    const row = stats[0] ?? {
      totalConnections: 0,
      connectedCount: 0,
      errorCount: 0,
      disconnectedCount: 0,
    }

    const result: McpServerHealthInfo = {
      serverId,
      totalConnections: Number(row.totalConnections),
      connectedCount: Number(row.connectedCount),
      errorCount: Number(row.errorCount),
      disconnectedCount: Number(row.disconnectedCount),
    }

    timer({ status: "success" })
    log.info("MCP server health retrieved", result)
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
