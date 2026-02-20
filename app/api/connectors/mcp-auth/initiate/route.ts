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
 * 3. Call auth(provider, { serverUrl }) from @ai-sdk/mcp
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
import { auth } from "@ai-sdk/mcp"
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq } from "drizzle-orm"
import { nexusMcpServers } from "@/lib/db/schema"
import { assertUserAccess, validateMcpServerUrl } from "@/lib/mcp/connector-service"
import { encryptToken } from "@/lib/crypto/token-encryption"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import { ServerSideOAuthProvider } from "@/lib/mcp/mcp-oauth-provider"

const log = createLogger({ action: "mcp-auth-initiate" })

/** Cookie name for the encrypted code verifier (per-server) */
export function getMcpAuthCookieName(serverId: string): string {
  return `mcp_auth_state_${serverId}`
}

/** Max age for the state cookie (5 minutes) */
const STATE_COOKIE_MAX_AGE = 300

/** UUID format regex */
const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

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
      assertUserAccess(server, userId, userRoleNames)
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
    validateMcpServerUrl(server.url)

    // 4. Build callback URL
    const baseUrl = getIssuerUrl()
    const redirectUrl = `${baseUrl}/api/connectors/mcp-auth/callback`

    // 5. Create provider and call auth()
    const provider = new ServerSideOAuthProvider({
      serverId,
      userId,
      redirectUrl,
    })

    const result = await auth(provider, {
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

    // 6. Encrypt code verifier + state into cookie for callback
    const cookiePayload = JSON.stringify({
      codeVerifier: await provider.codeVerifier(),
      serverId,
      userId,
      createdAt: Date.now(),
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
    log.error("MCP auth initiate failed", { requestId, error: String(error) })
    timer({ status: "error" })
    return NextResponse.json(
      { error: "Failed to initiate MCP OAuth flow" },
      { status: 500 }
    )
  }
}
