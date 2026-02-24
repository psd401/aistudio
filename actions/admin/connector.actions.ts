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
import { eq, count } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import type { ActionState } from "@/types/actions-types"
import type { SelectNexusMcpServer, InsertNexusMcpServer } from "@/lib/db/types"
import type { McpAuthType, McpToolSource } from "@/lib/mcp/connector-types"
import type { OAuthCredentialsConfig } from "@/lib/db/schema/tables/nexus-mcp-servers"
import { encryptToken } from "@/lib/crypto/token-encryption"
import { sql } from "drizzle-orm"

// ============================================
// Types
// ============================================

/** Admin-facing server info — omits secrets (mcpOauthRegistration, oauthCredentials). */
export interface McpServerWithStats extends Omit<SelectNexusMcpServer, "mcpOauthRegistration" | "oauthCredentials"> {
  connectionCount: number
  /** True when inline OAuth credentials are configured on this connector */
  hasOAuthCredentials: boolean
  /** How tools are provided: 'mcp' (fetch from server) or 'custom' (built-in definitions) */
  toolSource: string | null
}

/** Plaintext OAuth credentials from the admin form — clientSecret encrypted before storage */
export interface OAuthCredentialsInput {
  clientId: string
  clientSecret: string
  authorizationEndpointUrl?: string
  tokenEndpointUrl?: string
  scopes?: string
}

export interface CreateMcpServerInput {
  name: string
  url: string
  transport: "http" | "stdio" | "websocket"
  authType: McpAuthType
  toolSource?: McpToolSource
  credentialsKey?: string
  oauthCredentials?: OAuthCredentialsInput | null
  allowedUsers?: number[]
  maxConnections?: number
}

export interface UpdateMcpServerInput {
  id: string
  name?: string
  url?: string
  transport?: "http" | "stdio" | "websocket"
  authType?: McpAuthType
  toolSource?: McpToolSource
  credentialsKey?: string | null
  oauthCredentials?: OAuthCredentialsInput | null
  allowedUsers?: number[]
  maxConnections?: number
}

// Typed update payload — uses Drizzle's inferred insert type for type safety
type McpServerUpdate = Partial<
  Pick<
    InsertNexusMcpServer,
    | "name"
    | "url"
    | "transport"
    | "authType"
    | "toolSource"
    | "credentialsKey"
    | "oauthCredentials"
    | "allowedUsers"
    | "maxConnections"
    | "updatedAt"
  >
>

// ============================================
// Validation
// ============================================

const VALID_TRANSPORTS = ["http", "stdio", "websocket"] as const
const VALID_AUTH_TYPES = ["none", "oauth", "api_key", "jwt", "cognito_passthrough"] as const
const MAX_CONNECTIONS_LIMIT = 100

/**
 * Block private/loopback IP ranges and non-HTTP(S)/WS(S) protocols.
 * Prevents SSRF when admin-configured URLs are later used to establish connections.
 *
 * Known limitation: hostname-only checks do not mitigate DNS rebinding attacks.
 * An attacker controlling DNS could register a public IP, then re-point to a
 * private range (e.g., 169.254.169.254) after validation. Connection-time IP
 * pinning would be needed to fully mitigate this — tracked for a future iteration.
 */
function validateMcpUrl(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw ErrorFactories.invalidInput("url", "[redacted]", "Must be a valid URL")
  }

  // Use ENVIRONMENT (set by ECS task def) not NODE_ENV — ECS sets NODE_ENV=production
  // for all environments including dev. Mirrors rejectUnsafeMcpUrl() in connector-service.ts.
  const environment = process.env.ENVIRONMENT || process.env.DEPLOYMENT_ENV
  const isProduction = environment === "prod" || environment === "staging"

  const allowedProtocols = isProduction
    ? ["https:", "wss:"]
    : ["https:", "wss:", "http:", "ws:"]

  if (!allowedProtocols.includes(parsed.protocol)) {
    throw ErrorFactories.invalidInput(
      "url",
      "[redacted]",
      `Protocol must be one of: ${allowedProtocols.join(", ")}`
    )
  }

  // Private range patterns — kept in sync with rejectUnsafeMcpUrl() in connector-service.ts
  const hostname = parsed.hostname.toLowerCase()
  const privateRanges = [
    /^localhost$/i,
    /^0\.0\.0\.0$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./, // link-local / AWS IMDS
    /^\[?::1\]?$/,            // IPv6 loopback (bare or bracketed)
    /^\[?fc[\da-f]{2}:/i,     // IPv6 unique-local fc00::/7 (bare or bracketed)
    /^\[?fd[\da-f]{2}:/i,     // IPv6 unique-local fd00::/8
    /^\[?fe80:/i,             // IPv6 link-local
    /^\[?::ffff:/i,           // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
    /^metadata\.google\.internal$/,
  ]

  if (privateRanges.some((p) => p.test(hostname))) {
    throw ErrorFactories.invalidInput(
      "url",
      "[redacted]",
      "URL must not target internal network ranges"
    )
  }
}

/**
 * Validates OAuth credential endpoint URLs and clientId.
 * Reuses validateMcpUrl for SSRF prevention on stored endpoint URLs.
 */
function validateOAuthCredentials(creds: OAuthCredentialsInput): void {
  const trimmedId = creds.clientId.trim()
  if (trimmedId.length === 0 || trimmedId.length > 255) {
    throw ErrorFactories.invalidInput("clientId", "[redacted]", "Client ID must be 1–255 characters")
  }
  if (!creds.clientSecret) {
    throw ErrorFactories.invalidInput("clientSecret", "[redacted]", "Client Secret must not be empty")
  }
  if (creds.authorizationEndpointUrl) {
    validateMcpUrl(creds.authorizationEndpointUrl)
  }
  if (creds.tokenEndpointUrl) {
    validateMcpUrl(creds.tokenEndpointUrl)
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

/**
 * Strips secret fields (oauthCredentials, mcpOauthRegistration) from a DB row
 * before returning it to the client. The connectionCount defaults to 0 when
 * derived from a create/update (not a join query).
 */
function stripSecrets(row: SelectNexusMcpServer, connectionCount = 0): McpServerWithStats {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    transport: row.transport,
    authType: row.authType,
    toolSource: row.toolSource,
    credentialsKey: row.credentialsKey,
    allowedUsers: row.allowedUsers,
    maxConnections: row.maxConnections,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    connectionCount,
    hasOAuthCredentials: row.oauthCredentials !== null,
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
            toolSource: nexusMcpServers.toolSource,
            credentialsKey: nexusMcpServers.credentialsKey,
            allowedUsers: nexusMcpServers.allowedUsers,
            maxConnections: nexusMcpServers.maxConnections,
            createdAt: nexusMcpServers.createdAt,
            updatedAt: nexusMcpServers.updatedAt,
            connectionCount: count(nexusMcpConnections.id),
            hasOAuthCredentials: sql<boolean>`CASE WHEN ${nexusMcpServers.oauthCredentials} IS NOT NULL THEN true ELSE false END`,
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
      hasOAuthCredentials: Boolean(s.hasOAuthCredentials),
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
): Promise<ActionState<McpServerWithStats>> {
  const requestId = generateRequestId()
  const timer = startTimer("admin.createMcpServer")
  const log = createLogger({ requestId, action: "admin.createMcpServer" })

  try {
    await requireRole("administrator")

    log.info("Admin action started: Creating MCP server", {
      input: sanitizeForLogging({ name: input.name, url: input.url, transport: input.transport, authType: input.authType }),
      hasCredentials: !!input.credentialsKey,
    })

    validateMcpUrl(input.url)
    validateServerInput(input)

    // Encrypt OAuth client secret if inline credentials are provided
    let oauthCredentialsValue: OAuthCredentialsConfig | null = null
    if (input.oauthCredentials) {
      validateOAuthCredentials(input.oauthCredentials)
      oauthCredentialsValue = {
        clientId: input.oauthCredentials.clientId,
        encryptedClientSecret: await encryptToken(input.oauthCredentials.clientSecret),
        authorizationEndpointUrl: input.oauthCredentials.authorizationEndpointUrl,
        tokenEndpointUrl: input.oauthCredentials.tokenEndpointUrl,
        scopes: input.oauthCredentials.scopes,
      }
    }

    const [serverRow] = await executeQuery(
      (db) =>
        db
          .insert(nexusMcpServers)
          .values({
            name: input.name,
            url: input.url,
            transport: input.transport,
            authType: input.authType,
            toolSource: input.toolSource ?? "mcp",
            credentialsKey: input.credentialsKey ?? null,
            oauthCredentials: oauthCredentialsValue,
            allowedUsers: input.allowedUsers ?? [],
            maxConnections: input.maxConnections ?? 10,
          })
          .returning(),
      "createMcpServer"
    )

    timer({ status: "success", serverId: serverRow.id })
    log.info("MCP server created", { serverId: serverRow.id, name: serverRow.name })

    revalidatePath("/admin/connectors")
    return createSuccess(stripSecrets(serverRow), "Connector created successfully")
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
): Promise<ActionState<McpServerWithStats>> {
  const requestId = generateRequestId()
  const timer = startTimer("admin.updateMcpServer")
  const log = createLogger({ requestId, action: "admin.updateMcpServer" })

  try {
    await requireRole("administrator")

    log.info("Admin action started: Updating MCP server", {
      input: sanitizeForLogging({ serverId: input.id, name: input.name, url: input.url, transport: input.transport, authType: input.authType }),
      hasCredentials: input.credentialsKey !== undefined
        ? input.credentialsKey !== null
        : undefined,
    })

    if (input.url !== undefined) validateMcpUrl(input.url)
    validateServerInput(input)

    // Typed update payload — avoids Record<string, unknown>
    const { id: _, ...fields } = input
    const updateData: McpServerUpdate = {}
    if (fields.name !== undefined) updateData.name = fields.name
    if (fields.url !== undefined) updateData.url = fields.url
    if (fields.transport !== undefined) updateData.transport = fields.transport
    if (fields.authType !== undefined) updateData.authType = fields.authType
    if (fields.toolSource !== undefined) updateData.toolSource = fields.toolSource
    if (fields.credentialsKey !== undefined)
      updateData.credentialsKey = fields.credentialsKey
    if (fields.oauthCredentials !== undefined) {
      if (fields.oauthCredentials === null) {
        // null clears inline credentials
        updateData.oauthCredentials = null
      } else {
        validateOAuthCredentials(fields.oauthCredentials)
        updateData.oauthCredentials = {
          clientId: fields.oauthCredentials.clientId,
          encryptedClientSecret: await encryptToken(fields.oauthCredentials.clientSecret),
          authorizationEndpointUrl: fields.oauthCredentials.authorizationEndpointUrl,
          tokenEndpointUrl: fields.oauthCredentials.tokenEndpointUrl,
          scopes: fields.oauthCredentials.scopes,
        }
      }
    }
    if (fields.allowedUsers !== undefined)
      updateData.allowedUsers = fields.allowedUsers
    if (fields.maxConnections !== undefined)
      updateData.maxConnections = fields.maxConnections

    // Drizzle does not auto-update timestamps — set explicitly
    updateData.updatedAt = new Date()

    if (Object.keys(updateData).length <= 1) {
      const [currentRow] = await executeQuery(
        (db) =>
          db
            .select()
            .from(nexusMcpServers)
            .where(eq(nexusMcpServers.id, input.id))
            .limit(1),
        "updateMcpServer.noOp"
      )
      if (!currentRow) {
        throw ErrorFactories.dbRecordNotFound("nexus_mcp_servers", input.id)
      }
      timer({ status: "noop" })
      log.info("Update called with no fields to change", { serverId: input.id })
      const stripped: McpServerWithStats = stripSecrets(currentRow)
      return createSuccess(stripped, "No changes to update")
    }

    const [serverRow] = await executeQuery(
      (db) =>
        db
          .update(nexusMcpServers)
          .set(updateData)
          .where(eq(nexusMcpServers.id, input.id))
          .returning(),
      "updateMcpServer"
    )

    if (!serverRow) {
      throw ErrorFactories.dbRecordNotFound("nexus_mcp_servers", input.id)
    }

    timer({ status: "success", serverId: serverRow.id })
    log.info("MCP server updated", { serverId: serverRow.id })

    revalidatePath("/admin/connectors")
    return createSuccess(stripSecrets(serverRow), "Connector updated successfully")
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

