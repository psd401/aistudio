/**
 * MCP Connector Service
 *
 * Backend core for connecting AI Studio to external MCP servers as a client.
 * Manages MCP client lifecycle, tool fetching, token management, and audit logging.
 *
 * Part of Epic #774 — Nexus MCP Connectors
 * Issue #778
 *
 * @see lib/mcp/connector-types.ts for type definitions
 * @see lib/crypto/token-encryption.ts for token encrypt/decrypt (Issue #777)
 * @see lib/db/schema/tables/nexus-mcp-user-tokens.ts for token storage (Issue #776)
 */

import { createMCPClient } from "@ai-sdk/mcp"
import { eq, and, or, sql } from "drizzle-orm"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client"
import {
  nexusMcpServers,
  nexusMcpUserTokens,
  nexusMcpAuditLogs,
} from "@/lib/db/schema"
import { encryptToken, decryptToken } from "@/lib/crypto/token-encryption"
import type {
  McpConnector,
  McpAuthType,
  McpTransportType,
  McpUserConnectionStatus,
  McpConnectionStatus,
  McpTokenRefreshResult,
  McpConnectorToolsResult,
  McpToolCallLogEntry,
} from "./connector-types"

const log = createLogger({ action: "mcp-connector-service" })

// ─── Connector Listing ───────────────────────────────────────────────────────

/**
 * Returns MCP connectors accessible by the given user.
 *
 * Access rules:
 * 1. If `allowedUsers` is non-empty, user must be in the list
 * 2. Otherwise, user must have "administrator" or "staff" role
 */
export async function getAvailableConnectors(
  userId: number,
  userRoleNames: string[]
): Promise<McpConnector[]> {
  const requestId = generateRequestId()
  const timer = startTimer("getAvailableConnectors")

  log.info("Fetching available connectors", { requestId, userId })

  const hasDefaultAccess =
    userRoleNames.includes("administrator") || userRoleNames.includes("staff")

  // Filter at DB level: user in allowedUsers[], OR empty allowedUsers + admin/staff role
  const accessible = await executeQuery(
    (db) =>
      db
        .select()
        .from(nexusMcpServers)
        .where(
          or(
            // User is explicitly in the allow list
            sql`${userId} = ANY(${nexusMcpServers.allowedUsers})`,
            // Or the list is empty and user has default role-based access
            hasDefaultAccess
              ? sql`coalesce(cardinality(${nexusMcpServers.allowedUsers}), 0) = 0`
              : undefined
          )
        ),
    "getAvailableConnectors"
  )

  timer({ status: "success", count: accessible.length })
  log.info("Connectors retrieved", { requestId, count: accessible.length })

  return accessible.map(toMcpConnector)
}

// ─── Connection Status ───────────────────────────────────────────────────────

/**
 * Checks whether a user has a valid (non-expired) token for the given server.
 */
export async function getUserConnectionStatus(
  userId: number,
  serverId: string
): Promise<McpUserConnectionStatus> {
  const rows = await executeQuery(
    (db) =>
      db
        .select()
        .from(nexusMcpUserTokens)
        .where(
          and(
            eq(nexusMcpUserTokens.userId, userId),
            eq(nexusMcpUserTokens.serverId, serverId)
          )
        )
        .limit(1),
    "getUserConnectionStatus"
  )

  if (rows.length === 0) {
    return { serverId, status: "no_token", tokenExpiresAt: null }
  }

  const token = rows[0]
  const now = new Date()
  const status: McpConnectionStatus =
    token.tokenExpiresAt && token.tokenExpiresAt < now
      ? "token_expired"
      : "connected"

  return {
    serverId,
    status,
    tokenExpiresAt: token.tokenExpiresAt,
  }
}

// ─── Tool Fetching ───────────────────────────────────────────────────────────

/**
 * Creates an MCP client, fetches tools from the server, and returns them
 * as AI SDK–compatible tools for use with `streamText`.
 *
 * The caller MUST invoke `close()` on the result when done (e.g. in onFinish/onError).
 */
export async function getConnectorTools(
  serverId: string,
  userId: number
): Promise<McpConnectorToolsResult> {
  const requestId = generateRequestId()
  const timer = startTimer("getConnectorTools")

  log.info("Fetching connector tools", { requestId, serverId, userId })

  // 1. Load server config
  const servers = await executeQuery(
    (db) =>
      db
        .select()
        .from(nexusMcpServers)
        .where(eq(nexusMcpServers.id, serverId))
        .limit(1),
    "getConnectorTools:server"
  )

  if (servers.length === 0) {
    throw new Error(`MCP server not found: ${serverId}`)
  }

  const server = servers[0]

  // 2. Validate transport — @ai-sdk/mcp only supports "http" and "sse"
  assertHttpTransport(server.transport)

  // 3. Validate URL — prevent SSRF against internal/metadata endpoints
  validateMcpServerUrl(server.url)

  // 4. Resolve auth headers
  const headers = await resolveAuthHeaders(server.authType as McpAuthType, userId, serverId)

  // 5. Create MCP client (per-request lifecycle)
  const client = await createMCPClient({
    transport: {
      type: "http",
      url: server.url,
      headers,
    },
    name: "aistudio-connector",
  })

  // 6. Fetch tools — close client on failure to prevent resource leaks
  let tools
  try {
    tools = await client.tools()
  } catch (error) {
    try { await client.close() } catch { /* ignore cleanup errors */ }
    throw error
  }

  timer({ status: "success", toolCount: Object.keys(tools).length })
  log.info("Connector tools fetched", {
    requestId,
    serverId,
    serverName: server.name,
    toolCount: Object.keys(tools).length,
  })

  return {
    serverId,
    serverName: server.name,
    tools,
    close: () => client.close(),
  }
}

// ─── Token Refresh ───────────────────────────────────────────────────────────

/**
 * Refreshes an OAuth access token using the stored encrypted refresh token.
 *
 * On success, atomically updates the user token row with the new encrypted tokens.
 * On failure, returns `{ reconnectRequired: true }` so the client can initiate
 * a new OAuth flow.
 */
export async function refreshUserToken(
  userId: number,
  serverId: string
): Promise<McpTokenRefreshResult> {
  const requestId = generateRequestId()
  const timer = startTimer("refreshUserToken")

  log.info("Attempting token refresh", { requestId, userId, serverId })

  // 1. Load existing token row
  const rows = await executeQuery(
    (db) =>
      db
        .select()
        .from(nexusMcpUserTokens)
        .where(
          and(
            eq(nexusMcpUserTokens.userId, userId),
            eq(nexusMcpUserTokens.serverId, serverId)
          )
        )
        .limit(1),
    "refreshUserToken:loadToken"
  )

  if (rows.length === 0 || !rows[0].encryptedRefreshToken) {
    log.warn("No refresh token available", { requestId, userId, serverId })
    timer({ status: "error" })
    return { success: false, reconnectRequired: true }
  }

  const tokenRow = rows[0]

  // 2. Decrypt refresh token
  let refreshToken: string
  try {
    // Safe: we checked `!rows[0].encryptedRefreshToken` above
    refreshToken = await decryptToken(tokenRow.encryptedRefreshToken!)
  } catch (err) {
    log.warn("Failed to decrypt refresh token", { requestId, error: String(err) })
    timer({ status: "error" })
    return { success: false, reconnectRequired: true }
  }

  // 3. Load server config for token endpoint
  const servers = await executeQuery(
    (db) =>
      db
        .select()
        .from(nexusMcpServers)
        .where(eq(nexusMcpServers.id, serverId))
        .limit(1),
    "refreshUserToken:loadServer"
  )

  if (servers.length === 0) {
    throw new Error(`MCP server not found: ${serverId}`)
  }

  const server = servers[0]

  // 4. Validate server URL — prevent SSRF
  validateMcpServerUrl(server.url)

  // 5. Exchange refresh token for new access token
  // The token endpoint is derived from the server URL (convention: /oauth/token)
  const tokenEndpoint = new URL("/oauth/token", server.url).toString()

  let tokenResponse: OAuthTokenResponse
  try {
    const resp = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    })

    if (!resp.ok) {
      log.warn("Token refresh request failed", { requestId, status: resp.status })
      timer({ status: "error" })
      return { success: false, reconnectRequired: true }
    }

    const json = await resp.json()
    tokenResponse = parseOAuthTokenResponse(json)
  } catch (err) {
    log.warn("Token refresh failed", { requestId, error: String(err) })
    timer({ status: "error" })
    return { success: false, reconnectRequired: true }
  }

  // 5. Encrypt new tokens and update DB atomically
  const newEncryptedAccess = await encryptToken(tokenResponse.access_token)
  const newEncryptedRefresh = tokenResponse.refresh_token
    ? await encryptToken(tokenResponse.refresh_token)
    : tokenRow.encryptedRefreshToken ?? undefined

  const expiresAt = tokenResponse.expires_in
    ? new Date(Date.now() + tokenResponse.expires_in * 1000)
    : null

  await executeTransaction(
    async (tx) => {
      await tx
        .update(nexusMcpUserTokens)
        .set({
          encryptedAccessToken: newEncryptedAccess,
          encryptedRefreshToken: newEncryptedRefresh,
          tokenExpiresAt: expiresAt,
          scope: tokenResponse.scope ?? tokenRow.scope,
          updatedAt: new Date(),
        })
        .where(eq(nexusMcpUserTokens.id, tokenRow.id))
    },
    "refreshUserToken:updateTokens"
  )

  timer({ status: "success" })
  log.info("Token refresh successful", { requestId, userId, serverId })

  return { success: true, tokenExpiresAt: expiresAt ?? undefined }
}

/** Minimal OAuth token response shape */
interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type: string
}

/** Runtime validation for external OAuth token responses (no zod dependency) */
function parseOAuthTokenResponse(json: unknown): OAuthTokenResponse {
  if (
    typeof json !== "object" ||
    json === null ||
    typeof (json as Record<string, unknown>).access_token !== "string" ||
    typeof (json as Record<string, unknown>).token_type !== "string"
  ) {
    throw new Error("Invalid OAuth token response: missing access_token or token_type")
  }
  const obj = json as Record<string, unknown>
  return {
    access_token: obj.access_token as string,
    token_type: obj.token_type as string,
    refresh_token: typeof obj.refresh_token === "string" ? obj.refresh_token : undefined,
    expires_in: typeof obj.expires_in === "number" ? obj.expires_in : undefined,
    scope: typeof obj.scope === "string" ? obj.scope : undefined,
  }
}

// ─── Audit Logging ───────────────────────────────────────────────────────────

/**
 * Writes an audit log entry for an MCP tool call.
 *
 * This is fire-and-forget — errors are logged but do not propagate.
 */
export async function logToolCall(entry: McpToolCallLogEntry): Promise<void> {
  try {
    await executeQuery(
      (db) =>
        db.insert(nexusMcpAuditLogs).values({
          userId: entry.userId,
          serverId: entry.serverId,
          toolName: entry.toolName,
          input: truncateForAudit(entry.input),
          output: truncateForAudit(entry.output),
          durationMs: entry.durationMs,
          error: entry.error ?? null,
        }),
      "logToolCall"
    )
  } catch (err) {
    // Audit log failure must not break the request
    log.warn("Failed to write MCP audit log", { error: String(err) })
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Validation Helpers ──────────────────────────────────────────────────────

/** Max size for audit log JSONB payloads (64 KB) */
const MAX_AUDIT_PAYLOAD_BYTES = 64 * 1024

/** Truncates large JSONB payloads before audit log insert */
function truncateForAudit(
  data: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!data) return null
  const json = JSON.stringify(data)
  if (json.length <= MAX_AUDIT_PAYLOAD_BYTES) return data
  return { _truncated: true, _sizeBytes: json.length }
}

/**
 * Validates that a server URL is safe for outbound requests (SSRF prevention).
 * Blocks private/internal addresses and non-HTTPS schemes in production.
 */
function validateMcpServerUrl(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error("Invalid MCP server URL")
  }

  const isProduction = process.env.NODE_ENV === "production"

  if (isProduction && parsed.protocol !== "https:") {
    throw new Error("MCP server URL must use HTTPS in production")
  }

  if (!isProduction && !["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("MCP server URL must use HTTP or HTTPS")
  }

  const hostname = parsed.hostname.toLowerCase()
  const privatePatterns = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./, // link-local / AWS IMDS
    /^::1$/,
    /^metadata\.google\.internal$/,
  ]

  if (isProduction && privatePatterns.some((p) => p.test(hostname))) {
    throw new Error("MCP server URL must not target private/internal addresses")
  }
}

/**
 * Asserts the transport value from the DB is supported by @ai-sdk/mcp.
 * The DB schema allows stdio/http/websocket, but the SDK only supports http transport
 * for server-to-server communication.
 */
function assertHttpTransport(transport: string): asserts transport is "http" {
  if (transport !== "http") {
    throw new Error(
      `Unsupported MCP transport: "${transport}". Only "http" is supported for server-to-server connections.`
    )
  }
}

/** Maps a DB row to the McpConnector type */
function toMcpConnector(row: typeof nexusMcpServers.$inferSelect): McpConnector {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    transport: row.transport as McpTransportType,
    authType: row.authType as McpAuthType,
    allowedUsers: row.allowedUsers ?? [],
    maxConnections: row.maxConnections ?? 10,
  }
}

/**
 * Resolves HTTP headers for authenticating to an MCP server.
 *
 * Auth types match the DB CHECK constraint in 028-nexus-schema.sql:
 * - "oauth": Bearer token from per-user encrypted token store
 * - "jwt": Bearer token (JWT-based auth)
 * - "api_key": X-API-Key header
 * - "none": no auth headers
 */
async function resolveAuthHeaders(
  authType: McpAuthType,
  userId: number,
  serverId: string
): Promise<Record<string, string>> {
  if (authType === "none") {
    return {}
  }

  const rows = await executeQuery(
    (db) =>
      db
        .select()
        .from(nexusMcpUserTokens)
        .where(
          and(
            eq(nexusMcpUserTokens.userId, userId),
            eq(nexusMcpUserTokens.serverId, serverId)
          )
        )
        .limit(1),
    "resolveAuthHeaders"
  )

  if (rows.length === 0) {
    log.warn("No token found for user on server", { userId, serverId })
    throw new Error("No token found. User must authenticate first.")
  }

  const accessToken = await decryptToken(rows[0].encryptedAccessToken)

  switch (authType) {
    case "oauth":
    case "jwt":
      return { Authorization: `Bearer ${accessToken}` }
    case "api_key":
      return { "X-API-Key": accessToken }
    default: {
      // authType is constrained by McpAuthType; "none" handled above.
      // If a new type is added to the DB without updating this switch, fail loud.
      const _exhaustive: never = authType
      throw new Error(`Unsupported auth type: ${_exhaustive}`)
    }
  }
}
