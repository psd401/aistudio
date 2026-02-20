/**
 * OAuth Authorization Endpoint for MCP Connectors
 *
 * GET /api/connectors/oauth/authorize?serverId=<uuid>
 *
 * Generates an OAuth authorization URL for the given MCP server, stores PKCE
 * code_verifier + state in an encrypted httpOnly cookie, and returns the URL
 * for the client to open in a popup window.
 *
 * Security:
 * - PKCE S256 required (RFC 7636)
 * - State nonce prevents CSRF
 * - Cookie encrypted via AES-256-GCM (reuses token-encryption DEK)
 * - Cookie is httpOnly, Secure, SameSite=Lax, Max-Age=300
 *
 * Part of Epic #774 — Nexus MCP Connectors
 * Issue #779
 */

import { cookies } from "next/headers"
import { createHash, randomBytes } from "node:crypto"
import { NextResponse } from "next/server"
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq } from "drizzle-orm"
import { nexusMcpServers } from "@/lib/db/schema"
import { requireUserAccess, loadOAuthCredentials, rejectUnsafeMcpUrl } from "@/lib/mcp/connector-service"
import { encryptToken } from "@/lib/crypto/token-encryption"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"

const log = createLogger({ action: "oauth-authorize" })

/**
 * Builds a per-server cookie name for the encrypted PKCE state.
 * Using a per-server suffix allows concurrent OAuth flows for different
 * connectors without one overwriting the other's cookie.
 */
export function getOAuthStateCookieName(serverId: string): string {
  // Full UUID avoids collisions when only later segments differ.
  // Dashes are valid in cookie names per RFC 6265.
  return `mcp_oauth_state_${serverId}`
}

/** Max age for the state cookie (5 minutes — generous window for popup flow) */
const STATE_COOKIE_MAX_AGE = 300

/**
 * Generates a cryptographically random code_verifier (RFC 7636 §4.1).
 * 32 random bytes → 43 base64url characters (within the 43-128 range).
 */
function generateCodeVerifier(): string {
  return randomBytes(32)
    .toString("base64url")
}

/**
 * Computes code_challenge = base64url(SHA256(code_verifier)) (RFC 7636 §4.2).
 */
function computeCodeChallenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64url")
}

export async function GET(req: Request): Promise<Response> {
  const requestId = generateRequestId()
  const timer = startTimer("oauth.authorize")

  try {
    // 1. Authenticate (getCurrentUserAction calls getServerSession internally)
    const currentUser = await getCurrentUserAction()
    if (!currentUser.isSuccess) {
      log.warn("Unauthorized OAuth authorize attempt", { requestId })
      timer({ status: "error", reason: "unauthorized" })
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = currentUser.data.user.id
    const userRoleNames = currentUser.data.roles.map((r: { name: string }) => r.name)

    // 2. Validate serverId param
    const { searchParams } = new URL(req.url)
    const serverId = searchParams.get("serverId")
    if (!serverId) {
      timer({ status: "error", reason: "missing_server_id" })
      return NextResponse.json({ error: "serverId query parameter is required" }, { status: 400 })
    }

    // UUID format validation (hex digits + dashes in canonical 8-4-4-4-12 form)
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(serverId)) {
      timer({ status: "error", reason: "invalid_server_id" })
      return NextResponse.json({ error: "Invalid serverId format" }, { status: 400 })
    }

    log.info("Starting OAuth authorize flow", { requestId, serverId, userId })

    // 3. Load server config
    const serverRows = await executeQuery(
      (db) =>
        db
          .select()
          .from(nexusMcpServers)
          .where(eq(nexusMcpServers.id, serverId))
          .limit(1),
      "oauth-authorize:loadServer"
    )

    if (serverRows.length === 0) {
      timer({ status: "error", reason: "server_not_found" })
      return NextResponse.json({ error: "MCP server not found" }, { status: 404 })
    }

    const server = serverRows[0]

    // Access control: same rules as getConnectorTools / tool invocations
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

    if (!server.credentialsKey) {
      log.error("OAuth server missing credentialsKey", { requestId, serverId })
      timer({ status: "error", reason: "no_credentials_key" })
      return NextResponse.json(
        { error: "Server OAuth configuration is incomplete" },
        { status: 500 }
      )
    }

    // 4. Load OAuth credentials from Secrets Manager
    const credentials = await loadOAuthCredentials(server.credentialsKey)

    if (!credentials.authorizationEndpointUrl) {
      log.error("OAuth credentials missing authorizationEndpointUrl", {
        requestId,
        serverId,
        credentialsKey: server.credentialsKey,
      })
      timer({ status: "error", reason: "no_auth_endpoint" })
      return NextResponse.json(
        { error: "Server OAuth configuration is incomplete (missing authorization endpoint)" },
        { status: 500 }
      )
    }

    // 5. Generate PKCE code_verifier and code_challenge
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = computeCodeChallenge(codeVerifier)

    // 6. Generate state nonce (prefixed with serverId for cookie routing in callback)
    const nonce = randomBytes(32).toString("base64url")
    const state = `${serverId}:${nonce}`

    // 7. Build redirect URI
    const baseUrl = getIssuerUrl()
    const redirectUri = `${baseUrl}/api/connectors/oauth/callback`

    // 8. Build authorization URL (validate against SSRF before redirecting user)
    rejectUnsafeMcpUrl(credentials.authorizationEndpointUrl)
    const authUrl = new URL(credentials.authorizationEndpointUrl)
    authUrl.searchParams.set("response_type", "code")
    authUrl.searchParams.set("client_id", credentials.clientId)
    authUrl.searchParams.set("redirect_uri", redirectUri)
    authUrl.searchParams.set("state", state)
    authUrl.searchParams.set("code_challenge", codeChallenge)
    authUrl.searchParams.set("code_challenge_method", "S256")

    if (credentials.scopes) {
      authUrl.searchParams.set("scope", credentials.scopes)
    }

    // 9. Encrypt and store state in cookie
    const cookiePayload = JSON.stringify({
      state,
      codeVerifier,
      serverId,
      userId,
      createdAt: Date.now(),
    })
    const encryptedState = await encryptToken(cookiePayload)

    const cookieStore = await cookies()
    cookieStore.set(getOAuthStateCookieName(serverId), encryptedState, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: STATE_COOKIE_MAX_AGE,
      path: "/api/connectors/oauth",
    })

    timer({ status: "success" })
    log.info("OAuth authorization URL generated", { requestId, serverId })

    return NextResponse.json({ url: authUrl.toString() })
  } catch (error) {
    log.error("OAuth authorize failed", { requestId, error: String(error) })
    timer({ status: "error" })
    return NextResponse.json(
      { error: "Failed to initiate OAuth flow" },
      { status: 500 }
    )
  }
}
