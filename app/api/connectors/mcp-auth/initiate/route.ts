/**
 * MCP-Native OAuth Initiation Endpoint
 *
 * GET /api/connectors/mcp-auth/initiate?serverId=<uuid>
 *
 * Uses the MCP protocol's built-in OAuth support (metadata discovery, dynamic
 * client registration, PKCE) instead of admin-configured client credentials.
 *
 * Flow:
 * 1. Authenticate user, load server config
 * 2. Create ServerSideOAuthProvider instance
 * 3. Call exchangeMcpOAuthTokens(provider, { serverUrl }) from @ai-sdk/mcp
 *    - SDK discovers server metadata (.well-known/oauth-authorization-server)
 *    - SDK performs dynamic client registration if needed
 *    - SDK calls provider.redirectToAuthorization(url) → we capture it
 * 4. Save code verifier to encrypted cookie
 * 5. Return { url: capturedAuthUrl } to frontend
 *
 * Part of Epic #774 — Nexus MCP Connectors
 * Issue #797
 */

import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { exchangeMcpOAuthTokens } from "@/lib/mcp/mcp-auth-utils"
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq } from "drizzle-orm"
import { nexusMcpServers } from "@/lib/db/schema"
import { requireUserAccess, rejectUnsafeMcpUrl, getOAuthCredentials } from "@/lib/mcp/connector-service"
import { encryptToken } from "@/lib/crypto/token-encryption"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import { ServerSideOAuthProvider } from "@/lib/mcp/mcp-oauth-provider"
import {
  UUID_RE,
  getMcpAuthCookieName,
  classifyMcpOAuthError,
  generateCodeVerifier,
  generateCodeChallenge,
  generateStateToken,
} from "@/lib/mcp/mcp-auth-utils"

const log = createLogger({ action: "mcp-auth-initiate" })

/** Max age for the state cookie (5 minutes) */
const STATE_COOKIE_MAX_AGE = 300

export async function GET(req: Request): Promise<Response> {
  const requestId = generateRequestId()
  const timer = startTimer("mcp-auth.initiate")

  try {
    // 1. Authenticate
    const currentUser = await getCurrentUserAction()
    if (!currentUser.isSuccess) {
      log.warn("Unauthorized MCP auth initiate attempt", { requestId })
      timer({ status: "error", reason: "unauthorized" })
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = currentUser.data.user.id
    const userRoleNames = currentUser.data.roles.map((r: { name: string }) => r.name)

    // 2. Validate serverId param
    // CodeQL js/user-controlled-bypass dismissed (alert #394): RFC 6749 requires serverId
    // validation. User authenticated above. Sink is auth() from @ai-sdk/mcp.
    const { searchParams } = new URL(req.url)
    const serverId = searchParams.get("serverId")
    if (!serverId || !UUID_RE.test(serverId)) {
      timer({ status: "error", reason: "invalid_server_id" })
      return NextResponse.json({ error: "Invalid serverId" }, { status: 400 })
    }

    log.info("Starting MCP-native OAuth flow", { requestId, serverId, userId })

    // 3. Load server config
    const serverRows = await executeQuery(
      (db) =>
        db
          .select()
          .from(nexusMcpServers)
          .where(eq(nexusMcpServers.id, serverId))
          .limit(1),
      "mcp-auth-initiate:loadServer"
    )

    if (serverRows.length === 0) {
      timer({ status: "error", reason: "server_not_found" })
      return NextResponse.json({ error: "MCP server not found" }, { status: 404 })
    }

    const server = serverRows[0]

    // Access control
    try {
      requireUserAccess(server, userId, userRoleNames)
    } catch {
      log.warn("User lacks access to connector", { requestId, serverId, userId })
      timer({ status: "error", reason: "forbidden" })
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    if (server.authType !== "oauth") {
      timer({ status: "error", reason: "not_oauth" })
      return NextResponse.json(
        { error: "Server does not use OAuth authentication" },
        { status: 400 }
      )
    }

    // Validate server URL (SSRF prevention)
    rejectUnsafeMcpUrl(server.url)

    // 4. Build callback URL
    const baseUrl = getIssuerUrl()
    const redirectUrl = `${baseUrl}/api/connectors/mcp-auth/callback`

    // ── Pre-registered OAuth flow ──────────────────────────────────────────
    // When the server has inline or Secrets Manager credentials, bypass the
    // SDK's auth() and dynamic registration. Build the authorization URL
    // ourselves using the custom authorize endpoint from credentials.
    const credentials = await getOAuthCredentials(server)
    if (credentials) {

      if (!credentials.authorizationEndpointUrl) {
        log.error("Missing authorizationEndpointUrl in credentials", { requestId, serverId })
        timer({ status: "error", reason: "missing_auth_endpoint" })
        return NextResponse.json(
          { error: "OAuth credentials are missing the authorization endpoint URL." },
          { status: 500 }
        )
      }

      // Generate PKCE code_verifier + S256 code_challenge
      const codeVerifier = generateCodeVerifier()
      const codeChallenge = generateCodeChallenge(codeVerifier)

      // Generate state token for CSRF (format: serverId:randomToken)
      const stateToken = `${serverId}:${generateStateToken()}`

      // Build authorization URL
      const authUrl = new URL(credentials.authorizationEndpointUrl)
      authUrl.searchParams.set("response_type", "code")
      authUrl.searchParams.set("client_id", credentials.clientId)
      authUrl.searchParams.set("redirect_uri", redirectUrl)
      authUrl.searchParams.set("code_challenge", codeChallenge)
      authUrl.searchParams.set("code_challenge_method", "S256")
      authUrl.searchParams.set("state", stateToken)
      if (credentials.scopes) {
        authUrl.searchParams.set("scope", credentials.scopes)
      }

      // Store state cookie (same pattern as MCP-native flow)
      const cookiePayload = JSON.stringify({
        codeVerifier,
        serverId,
        userId,
        createdAt: Date.now(),
        oauthState: stateToken,
      })
      const encryptedState = await encryptToken(cookiePayload)

      const cookieStore = await cookies()
      cookieStore.set(getMcpAuthCookieName(serverId), encryptedState, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: STATE_COOKIE_MAX_AGE,
        path: "/api/connectors/mcp-auth",
      })

      timer({ status: "success" })
      log.info("Pre-registered OAuth authorization URL generated", { requestId, serverId })

      return NextResponse.json({ url: authUrl.toString() })
    }

    // ── MCP-native OAuth flow (no credentialsKey) ──────────────────────────
    // 5. Create provider and call auth()
    const provider = new ServerSideOAuthProvider({
      serverId,
      userId,
      redirectUrl,
    })

    const result = await exchangeMcpOAuthTokens(provider, {
      serverUrl: server.url,
    })

    if (result === "AUTHORIZED") {
      // User already has valid tokens — no redirect needed
      timer({ status: "success", outcome: "already_authorized" })
      log.info("User already authorized for MCP server", { requestId, serverId })
      return NextResponse.json({ authorized: true })
    }

    // result === "REDIRECT" — provider.capturedAuthUrl has the authorization URL
    const authUrl = provider.capturedAuthUrl
    if (!authUrl) {
      log.error("auth() returned REDIRECT but no auth URL was captured", { requestId, serverId })
      timer({ status: "error", reason: "no_auth_url" })
      return NextResponse.json(
        { error: "Failed to generate authorization URL" },
        { status: 500 }
      )
    }

    // 6. Encrypt code verifier + state into cookie for callback.
    // oauthState is the exact state param the SDK embedded in authUrl — stored so
    // the callback can do a timing-safe comparison for CSRF protection.
    const cookiePayload = JSON.stringify({
      codeVerifier: await provider.codeVerifier(),
      serverId,
      userId,
      createdAt: Date.now(),
      oauthState: authUrl.searchParams.get("state") ?? null,
    })
    const encryptedState = await encryptToken(cookiePayload)

    const cookieStore = await cookies()
    cookieStore.set(getMcpAuthCookieName(serverId), encryptedState, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: STATE_COOKIE_MAX_AGE,
      path: "/api/connectors/mcp-auth",
    })

    timer({ status: "success" })
    log.info("MCP-native OAuth authorization URL generated", { requestId, serverId })

    return NextResponse.json({ url: authUrl.toString() })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log.error("MCP auth initiate failed", {
      requestId,
      error: errorMessage,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      cause: error instanceof Error && error.cause ? String(error.cause) : undefined,
    })
    timer({ status: "error" })

    // Return a specific error message for the frontend to display.
    // Internal details stay in server logs.
    const category = classifyMcpOAuthError(errorMessage)
    const userError = INITIATE_ERROR_MESSAGES[category] ?? INITIATE_ERROR_MESSAGES.unexpected
    return NextResponse.json({ error: userError }, { status: 500 })
  }
}

/**
 * User-facing error messages for the initiate endpoint.
 * Keyed by McpOAuthErrorCategory from the shared classifier.
 * Categories not applicable to this endpoint fall through to "unexpected".
 */
const INITIATE_ERROR_MESSAGES: Record<string, string> = {
  timeout: "The MCP server took too long to respond. Please try again.",
  connectivity: "Could not reach the MCP server. Check that the server URL is correct.",
  discovery: "Could not discover OAuth configuration from the MCP server. The server URL may be incorrect.",
  registration: "Dynamic client registration failed. The MCP server may not support automatic registration.",
  blocked: "The MCP server URL is not allowed (private/internal address).",
  not_found: "The MCP server configuration was not found.",
  unexpected: "Failed to start OAuth flow. Check server logs for details.",
}
