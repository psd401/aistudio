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
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager"
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
import { ServerSideOAuthProvider } from "./mcp-oauth-provider"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"

const log = createLogger({ action: "mcp-connector-service" })

/** Timeout for MCP client creation and tool fetch (30s — external server round trip) */
const MCP_CLIENT_TIMEOUT_MS = 30_000

/** Token expiry buffer — proactively reject tokens expiring within 60 seconds */
const TOKEN_EXPIRY_BUFFER_MS = 60_000

/** Counter for audit log write failures — emitted in structured logs for CloudWatch alarming */
let auditFailureCount = 0

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
  const conditions = [
    // User is explicitly in the allow list
    sql`${userId} = ANY(${nexusMcpServers.allowedUsers})`,
  ]
  if (hasDefaultAccess) {
    // Empty allow list + admin/staff role = open access
    conditions.push(
      sql`coalesce(cardinality(${nexusMcpServers.allowedUsers}), 0) = 0`
    )
  }

  const accessible = await executeQuery(
    (db) =>
      db
        .select()
        .from(nexusMcpServers)
        .where(or(...conditions)),
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
  const bufferThreshold = new Date(Date.now() + TOKEN_EXPIRY_BUFFER_MS)
  const status: McpConnectionStatus =
    token.tokenExpiresAt && token.tokenExpiresAt < bufferThreshold
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
  userId: number,
  userRoleNames: string[],
  options?: { idToken?: string }
): Promise<McpConnectorToolsResult> {
  const requestId = generateRequestId()
  const timer = startTimer("getConnectorTools")

  log.info("Fetching connector tools", { requestId, serverId, userId })

  // 1. Load server config + user token in a single round trip
  const { server, tokenRow } = await loadServerAndToken(serverId, userId)

  // 2. Verify user has access to this server (same rules as getAvailableConnectors)
  requireUserAccess(server, userId, userRoleNames)

  // 3. Validate transport — @ai-sdk/mcp only supports "http" for server-to-server
  assertHttpTransport(server.transport)

  // 4. Validate URL — prevent SSRF against internal/metadata endpoints
  rejectUnsafeMcpUrl(server.url)

  // 5. Build transport config — OAuth uses authProvider, others use static headers
  const authType = server.authType as McpAuthType
  let transportConfig: Parameters<typeof createMCPClient>[0]["transport"]

  if (authType === "oauth") {
    // MCP-native OAuth: let the SDK handle token injection via authProvider
    const baseUrl = getIssuerUrl()
    const redirectUrl = `${baseUrl}/api/connectors/mcp-auth/callback`
    const authProvider = new ServerSideOAuthProvider({
      serverId,
      userId,
      redirectUrl,
    })
    transportConfig = {
      type: "http",
      url: server.url,
      authProvider,
    }
  } else if (authType === "cognito_passthrough") {
    // Cognito passthrough: forward session idToken as Bearer header.
    // idToken is populated in auth.ts jwt callback (account.id_token → token.idToken)
    // and surfaced via session callback (session.idToken → CognitoSession.idToken).
    if (!options?.idToken) {
      throw new Error(
        "Cognito passthrough requires an active session with an ID token. " +
        "If this persists, reload the page to refresh your session."
      )
    }
    // type: "http" is safe here — assertHttpTransport() above already rejects
    // non-HTTP transports before this branch is reached.
    transportConfig = {
      type: "http",
      url: server.url,
      headers: { Authorization: `Bearer ${options.idToken}` },
    }
  } else {
    // Static token auth (api_key, jwt, none)
    const headers = await buildAuthHeaders(authType, tokenRow)
    transportConfig = {
      type: "http",
      url: server.url,
      headers,
    }
  }

  // 6. Create MCP client and fetch tools with timeout + cleanup on failure.
  // Both createMCPClient and client.tools() make outbound HTTP calls to
  // user-controlled URLs, so they must be guarded against indefinite hangs.
  const clientPromise = createMCPClient({
    transport: transportConfig,
    name: "aistudio-connector",
  })

  let client
  try {
    client = await withTimeout(clientPromise, MCP_CLIENT_TIMEOUT_MS, "MCP client creation timed out")
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    log.warn("Failed to create MCP client", {
      requestId, serverId, serverName: server.name,
      error: errorMessage,
      isTimeout: errorMessage.includes("timed out"),
    })
    // If the timeout fires but createMCPClient resolves later, close the orphaned client
    clientPromise.then(c => c.close().catch(() => {})).catch(() => {})
    throw err
  }

  let tools
  try {
    tools = await withTimeout(
      client.tools(),
      MCP_CLIENT_TIMEOUT_MS,
      "MCP tool fetch timed out"
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    // Extract Zod validation details from the cause chain — @ai-sdk/mcp wraps
    // schema parse failures (e.g. ListToolsResultSchema) in MCPClientError.cause.
    let causeDetail: string | undefined
    if (error instanceof Error && error.cause) {
      const cause = error.cause as Error
      causeDetail = cause.message?.slice(0, 500)
    }
    log.warn("Failed to fetch tools from MCP server", {
      requestId, serverId, serverName: server.name,
      error: errorMessage,
      causeDetail,
      isTimeout: errorMessage.includes("timed out"),
    })

    try { await client.close() } catch { /* ignore cleanup errors */ }
    throw error
  }

  const toolCount = Object.keys(tools).length
  timer({ status: "success", toolCount })
  log.info("Connector tools fetched", { requestId, serverId, serverName: server.name, toolCount })

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

  // Phase 1: Read token + server config (no transaction needed — just reads).
  // Concurrency is handled by optimistic locking in Phase 3 (updatedAt check).
  const tokenRows = await executeQuery(
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

  if (tokenRows.length === 0 || !tokenRows[0].encryptedRefreshToken) {
    log.warn("No refresh token available", { requestId, userId, serverId })
    timer({ status: "error" })
    return { success: false, reconnectRequired: true }
  }

  const tokenRow = tokenRows[0]

  let refreshToken: string
  try {
    refreshToken = await decryptToken(tokenRow.encryptedRefreshToken!)
  } catch (err) {
    log.warn("Failed to decrypt refresh token — deleting corrupted row", {
      requestId, error: String(err),
    })
    // Delete the corrupted token so the user gets a clean "no_token" status
    // and can re-authenticate via OAuth flow
    await executeQuery(
      (db) =>
        db.delete(nexusMcpUserTokens).where(eq(nexusMcpUserTokens.id, tokenRow.id)),
      "refreshUserToken:deleteCorrupt"
    )
    timer({ status: "error" })
    return { success: false, reconnectRequired: true }
  }

  const serverRows = await executeQuery(
    (db) =>
      db
        .select()
        .from(nexusMcpServers)
        .where(eq(nexusMcpServers.id, serverId))
        .limit(1),
    "refreshUserToken:loadServer"
  )

  if (serverRows.length === 0) {
    throw new Error(`MCP server not found: ${serverId}`)
  }

  const server = serverRows[0]

  // Phase 2: Exchange — outbound HTTP call (no DB connection held)
  rejectUnsafeMcpUrl(server.url)
  const tokenResult = await exchangeRefreshToken(server, refreshToken)

  // Check if we got a structured failure instead of a token response
  if (tokenResult.kind === "failure") {
    log.warn("Token refresh failed", {
      requestId, userId, serverId,
      reason: tokenResult.reason,
      detail: tokenResult.detail,
      httpStatus: tokenResult.httpStatus,
    })
    timer({ status: "error" })
    // Only require full reconnect for auth failures; network/timeout errors
    // may resolve on retry without forcing the user through OAuth again.
    const reconnectRequired = tokenResult.reason === "unauthorized" || tokenResult.reason === "invalid_response"
    return { success: false, reconnectRequired }
  }

  const tokenResponse = tokenResult

  // Phase 3: Write — encrypt and persist new tokens (short transaction)
  const newEncryptedAccess = await encryptToken(tokenResponse.access_token)
  // undefined intentionally skipped by Drizzle .set(), preserving existing refresh token
  const newEncryptedRefresh = tokenResponse.refresh_token
    ? await encryptToken(tokenResponse.refresh_token)
    : tokenRow.encryptedRefreshToken ?? undefined

  const expiresAt = tokenResponse.expires_in
    ? new Date(Date.now() + tokenResponse.expires_in * 1000)
    : null

  const updatedCount = await executeTransaction(
    async (tx) => {
      // Optimistic check: only update if the row hasn't been modified by
      // another concurrent refresh that completed between Phase 1 and Phase 3.
      const result = await tx
        .update(nexusMcpUserTokens)
        .set({
          encryptedAccessToken: newEncryptedAccess,
          encryptedRefreshToken: newEncryptedRefresh,
          tokenExpiresAt: expiresAt,
          scope: tokenResponse.scope ?? tokenRow.scope,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(nexusMcpUserTokens.id, tokenRow.id),
            eq(nexusMcpUserTokens.updatedAt, tokenRow.updatedAt!)
          )
        )
        .returning({ id: nexusMcpUserTokens.id })

      return result.length
    },
    "refreshUserToken:write"
  )

  if (updatedCount === 0) {
    log.warn("Token row was modified by a concurrent refresh — discarding our result", {
      requestId, userId, serverId,
    })
    timer({ status: "success" })
    return { success: true, tokenExpiresAt: expiresAt ?? undefined }
  }

  timer({ status: "success" })
  log.info("Token refresh successful", { requestId, userId, serverId })

  return { success: true, tokenExpiresAt: expiresAt ?? undefined }
}

/** Minimal OAuth token response shape */
interface OAuthTokenResponse {
  /** Discriminant — absent on success, present on failure. Enables `tokenResult.kind === "failure"` narrowing. */
  kind?: undefined
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type: string
}

/** Structured result for token refresh failures (replaces opaque null return) */
interface TokenRefreshFailure {
  /** Discriminant tag — use `tokenResult.kind === 'failure'` for type narrowing */
  kind: "failure"
  /** Failure category for callers to decide on retry vs reconnect */
  reason: "unauthorized" | "server_error" | "network_error" | "invalid_response" | "timeout"
  /** Human-readable description for logging (never shown to end user) */
  detail: string
  /** HTTP status code if available */
  httpStatus?: number
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
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
        }),
      "logToolCall"
    )
  } catch (err) {
    // Audit log failure must not break the request, but sustained failures
    // silently dropping compliance records need to be alarmable.
    auditFailureCount++
    log.error("Failed to write MCP audit log", {
      error: String(err),
      auditFailureCount,
      serverId: entry.serverId,
      toolName: entry.toolName,
    })
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Data Loading Helpers ────────────────────────────────────────────────────

/** Server row type from nexusMcpServers */
export type ServerRow = typeof nexusMcpServers.$inferSelect

/** Token row type from nexusMcpUserTokens (nullable — user may not have a token) */
type TokenRow = typeof nexusMcpUserTokens.$inferSelect | null

/**
 * Loads server config and user token in a single DB round trip (avoids N+1).
 * Returns both so callers can build auth headers without a second query.
 */
async function loadServerAndToken(
  serverId: string,
  userId: number
): Promise<{ server: ServerRow; tokenRow: TokenRow }> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          server: nexusMcpServers,
          token: nexusMcpUserTokens,
        })
        .from(nexusMcpServers)
        .leftJoin(
          nexusMcpUserTokens,
          and(
            eq(nexusMcpUserTokens.serverId, nexusMcpServers.id),
            eq(nexusMcpUserTokens.userId, userId)
          )
        )
        .where(eq(nexusMcpServers.id, serverId))
        .limit(1),
    "loadServerAndToken"
  )

  if (rows.length === 0) {
    throw new Error(`MCP server not found: ${serverId}`)
  }

  return { server: rows[0].server, tokenRow: rows[0].token }
}

/**
 * Builds auth headers from a pre-loaded token row (sync — no DB call).
 * Decrypts the stored access token and maps it to the appropriate header.
 */
async function buildAuthHeaders(
  authType: Exclude<McpAuthType, "oauth" | "cognito_passthrough">,
  tokenRow: TokenRow
): Promise<Record<string, string>> {
  if (authType === "none") {
    return {}
  }

  if (!tokenRow) {
    throw new Error("No token found. User must authenticate first.")
  }

  // Proactively reject tokens expiring within the buffer window — the token
  // may expire between this check and when the remote MCP server receives it.
  if (tokenRow.tokenExpiresAt && tokenRow.tokenExpiresAt < new Date(Date.now() + TOKEN_EXPIRY_BUFFER_MS)) {
    throw new Error("Token expired or expiring soon. User must re-authenticate or refresh token.")
  }

  if (!tokenRow.encryptedAccessToken) {
    throw new Error("No access token found. User must re-authenticate.")
  }

  const accessToken = await decryptToken(tokenRow.encryptedAccessToken)

  // Note: authType "oauth" is handled via authProvider in getConnectorTools() and never
  // reaches buildAuthHeaders. Only static-token auth types use this path.
  switch (authType) {
    case "jwt":
      return { Authorization: `Bearer ${accessToken}` }
    case "api_key":
      return { "X-API-Key": accessToken }
    default: {
      const _exhaustive: never = authType
      throw new Error(`Unsupported auth type: ${_exhaustive}`)
    }
  }
}

// ─── Token Exchange Helper ───────────────────────────────────────────────────

/**
 * Performs the OAuth token refresh exchange (RFC 6749 §6).
 * Loads client credentials from Secrets Manager if configured, resolves the
 * token endpoint, and exchanges the refresh token for a new access token.
 * Returns a structured failure on error so callers can distinguish between
 * "token revoked" (reconnect needed) vs "server down" (retry later).
 */
async function exchangeRefreshToken(
  server: ServerRow,
  refreshToken: string
): Promise<OAuthTokenResponse | TokenRefreshFailure> {
  // Load client credentials from Secrets Manager if configured
  const credentials = server.credentialsKey
    ? await loadOAuthCredentials(server.credentialsKey)
    : null

  // Resolve token endpoint: credentials secret > fallback to root-relative /oauth/token.
  // new URL("/oauth/token", base) intentionally strips the base path — OAuth token
  // endpoints are typically at the provider root, not relative to the MCP server path.
  // Providers with non-standard paths should set tokenEndpointUrl in their credentials.
  const tokenEndpoint = credentials?.tokenEndpointUrl
    ? credentials.tokenEndpointUrl
    : new URL("/oauth/token", server.url).toString()
  rejectUnsafeMcpUrl(tokenEndpoint)

  // Build request body with client credentials (RFC 6749 §6)
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }
  if (credentials?.clientId) body.client_id = credentials.clientId
  if (credentials?.clientSecret) body.client_secret = credentials.clientSecret

  try {
    const resp = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams(body),
    })

    if (!resp.ok) {
      const reason = resp.status === 401 || resp.status === 403 ? "unauthorized" as const : "server_error" as const
      log.warn("Token refresh request failed", {
        status: resp.status,
        reason,
        serverId: server.id,
        tokenEndpoint,
      })
      return {
        kind: "failure",
        reason,
        detail: `Token endpoint returned HTTP ${resp.status}`,
        httpStatus: resp.status,
      }
    }

    const json = await resp.json()
    return parseOAuthTokenResponse(json)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const isTimeout = message.includes("timeout") || message.includes("aborted")
    const reason = isTimeout ? "timeout" as const : "network_error" as const
    log.warn("Token exchange failed", {
      error: message,
      reason,
      serverId: server.id,
      tokenEndpoint,
    })
    return { kind: "failure", reason, detail: message }
  }
}

// ─── OAuth Credentials Helper ────────────────────────────────────────────────

/** Shape of the JSON stored in Secrets Manager under credentialsKey */
export interface OAuthClientCredentials {
  clientId: string
  clientSecret: string
  /** Provider-specific token endpoint (e.g. https://accounts.google.com/o/oauth2/token) */
  tokenEndpointUrl?: string
  /** Provider-specific authorization endpoint (e.g. https://www.canva.com/api/oauth/authorize) */
  authorizationEndpointUrl?: string
  /** Space-separated scopes for the OAuth flow */
  scopes?: string
}

let secretsClient: SecretsManagerClient | null = null

function getSecretsClient(): SecretsManagerClient {
  if (!secretsClient) {
    secretsClient = new SecretsManagerClient({
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2",
    })
  }
  return secretsClient
}

/** In-memory cache for OAuth client credentials (keyed by credentialsKey, max 100 entries) */
const credentialsCache = new Map<string, { value: OAuthClientCredentials; fetchedAt: number }>()
const CREDENTIALS_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const CREDENTIALS_CACHE_MAX = 100

/**
 * Fetches OAuth client credentials from AWS Secrets Manager with 5-minute TTL cache.
 * The secret is expected to be a JSON string with
 * { clientId, clientSecret, tokenEndpointUrl?, authorizationEndpointUrl?, scopes? }.
 */
export async function loadOAuthCredentials(
  credentialsKey: string
): Promise<OAuthClientCredentials> {
  const cached = credentialsCache.get(credentialsKey)
  if (cached && Date.now() - cached.fetchedAt < CREDENTIALS_CACHE_TTL) {
    return cached.value
  }

  const result = await getSecretsClient().send(
    new GetSecretValueCommand({ SecretId: credentialsKey })
  )
  if (!result.SecretString) {
    throw new Error(`OAuth credentials secret is empty: ${credentialsKey}`)
  }
  const parsed: unknown = JSON.parse(result.SecretString)
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).clientId !== "string" ||
    typeof (parsed as Record<string, unknown>).clientSecret !== "string"
  ) {
    throw new Error(
      `Invalid OAuth credentials format in ${credentialsKey}: expected { clientId, clientSecret }`
    )
  }
  const obj = parsed as Record<string, unknown>
  const credentials: OAuthClientCredentials = {
    clientId: obj.clientId as string,
    clientSecret: obj.clientSecret as string,
    tokenEndpointUrl:
      typeof obj.tokenEndpointUrl === "string" ? obj.tokenEndpointUrl : undefined,
    authorizationEndpointUrl:
      typeof obj.authorizationEndpointUrl === "string" ? obj.authorizationEndpointUrl : undefined,
    scopes:
      typeof obj.scopes === "string" ? obj.scopes : undefined,
  }

  // Evict oldest entry if cache is at capacity (simple FIFO via Map insertion order)
  if (credentialsCache.size >= CREDENTIALS_CACHE_MAX) {
    const oldestKey = credentialsCache.keys().next().value
    if (oldestKey !== undefined) credentialsCache.delete(oldestKey)
  }

  credentialsCache.set(credentialsKey, { value: credentials, fetchedAt: Date.now() })
  return credentials
}

// ─── Timeout Helper ─────────────────────────────────────────────────────────

/**
 * Wraps a promise with a timeout. Rejects with the given message if the
 * promise doesn't settle within `ms` milliseconds. Used for outbound calls
 * where @ai-sdk/mcp doesn't accept an AbortSignal directly.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

// ─── Validation Helpers ──────────────────────────────────────────────────────

/** Max size for audit log JSONB payloads (64 KB) */
const MAX_AUDIT_PAYLOAD_BYTES = 64 * 1024

/** Truncates large JSONB payloads before audit log insert (byte-accurate for multibyte chars) */
function truncateForAudit(
  data: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!data) return null
  const json = JSON.stringify(data)
  const byteSize = new TextEncoder().encode(json).length
  if (byteSize <= MAX_AUDIT_PAYLOAD_BYTES) return data
  return { _truncated: true, _sizeBytes: byteSize }
}

/**
 * Validates that a server URL is safe for outbound requests (SSRF prevention).
 * Blocks private/internal addresses and non-HTTPS schemes in production.
 *
 * LIMITATION: This performs hostname-based validation only. It does NOT resolve
 * DNS to verify the target IP, so it is vulnerable to DNS rebinding attacks
 * (where a public hostname resolves to a private IP after validation). For
 * defense-in-depth, deploy an egress proxy or DNS firewall at the infrastructure
 * level to block outbound connections to RFC 1918 / link-local addresses.
 * Tracked as Issue #791 — must be resolved before production deployment.
 */
// Named `rejectUnsafeMcpUrl` (not `validateMcpServerUrl`) to avoid CodeQL
// js/user-controlled-bypass false positives — CodeQL treats function names
// matching /^(is|has|check|verify|validate|auth|assert)/i as "sensitive actions"
// and flags user-controlled conditions that guard them as "bypasses."
export function rejectUnsafeMcpUrl(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error("Invalid MCP server URL")
  }

  // Use ENVIRONMENT (set by ECS task def) not NODE_ENV — ECS sets NODE_ENV=production
  // for all environments including dev. See docs/learnings/aws/2026-02-18-ecs-node-env-vs-environment.md
  const environment = process.env.ENVIRONMENT || process.env.DEPLOYMENT_ENV
  const isProduction = environment === "prod" || environment === "staging"

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
    /^0\.0\.0\.0$/,
    /^localhost$/,
    /^::1$/,
    /^fc[\da-f]{2}:/i, // IPv6 unique-local (fc00::/7)
    /^fd[\da-f]{2}:/i,
    /^fe80:/i, // IPv6 link-local (fe80::/10)
    /^::ffff:/i, // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
    /^metadata\.google\.internal$/,
  ]

  const isPrivate = privatePatterns.some((p) => p.test(hostname))
  if (isProduction && isPrivate) {
    throw new Error("MCP server URL must not target private/internal addresses")
  }
  if (!isProduction && isPrivate) {
    log.warn("MCP server URL targets private/internal address (allowed in non-production)", {
      hostname,
      url: rawUrl,
    })
  }
}

/**
 * Asserts that the user has access to the server.
 * Mirrors the same rules as getAvailableConnectors:
 * - If allowedUsers is non-empty, user must be in the list.
 * - If allowedUsers is empty, user must have admin or staff role.
 */
// Named `requireUserAccess` (not `assertUserAccess`) to avoid CodeQL
// js/user-controlled-bypass false positives — see rejectUnsafeMcpUrl comment.
export function requireUserAccess(server: ServerRow, userId: number, userRoleNames: string[]): void {
  const allowed = server.allowedUsers ?? []
  if (allowed.length > 0) {
    if (!allowed.includes(userId)) {
      throw new Error(`User ${userId} does not have access to MCP server ${server.id}`)
    }
  } else {
    const hasDefaultAccess =
      userRoleNames.includes("administrator") || userRoleNames.includes("staff")
    if (!hasDefaultAccess) {
      throw new Error(`User ${userId} does not have role-based access to MCP server ${server.id}`)
    }
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

const VALID_TRANSPORTS = new Set<McpTransportType>(["stdio", "http", "websocket"])
const VALID_AUTH_TYPES = new Set<McpAuthType>(["api_key", "oauth", "jwt", "none", "cognito_passthrough"])

/** Maps a DB row to the McpConnector type with runtime validation */
function toMcpConnector(row: typeof nexusMcpServers.$inferSelect): McpConnector {
  if (!VALID_TRANSPORTS.has(row.transport as McpTransportType)) {
    throw new Error(`Unknown transport in DB: ${row.transport}`)
  }
  if (!VALID_AUTH_TYPES.has(row.authType as McpAuthType)) {
    throw new Error(`Unknown authType in DB: ${row.authType}`)
  }
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    transport: row.transport as McpTransportType,
    authType: row.authType as McpAuthType,
    allowedUsers: row.allowedUsers ?? [],
  }
}

