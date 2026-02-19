/**
 * OAuth Callback Endpoint for MCP Connectors
 *
 * GET /api/connectors/oauth/callback?code=<auth_code>&state=<state>
 *
 * Receives the authorization code from the OAuth provider redirect, validates
 * state against the encrypted cookie, exchanges the code for tokens using PKCE,
 * encrypts and stores tokens in `nexus_mcp_user_tokens`, then renders an HTML
 * page that sends postMessage to the opener window and closes the popup.
 *
 * Security:
 * - State validated against encrypted cookie (CSRF prevention)
 * - PKCE code_verifier from cookie used in token exchange (S256)
 * - Auth code exchange completes within 60s of issuance
 * - Origin validation on postMessage (set by opener)
 * - Tokens encrypted before DB storage (AES-256-GCM)
 *
 * Part of Epic #774 — Nexus MCP Connectors
 * Issue #779
 */

import { cookies } from "next/headers"
import { timingSafeEqual } from "node:crypto"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, and } from "drizzle-orm"
import { nexusMcpServers, nexusMcpUserTokens } from "@/lib/db/schema"
import { loadOAuthCredentials, validateMcpServerUrl } from "@/lib/mcp/connector-service"
import { encryptToken, decryptToken } from "@/lib/crypto/token-encryption"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import { OAUTH_STATE_COOKIE } from "../authorize/route"

const log = createLogger({ action: "oauth-callback" })

/** Max age of the state cookie before it's considered expired (5 minutes) */
const STATE_MAX_AGE_MS = 5 * 60 * 1000

interface OAuthStateCookie {
  state: string
  codeVerifier: string
  serverId: string
  userId: number
  createdAt: number
}

/** Minimal OAuth token response shape (same as connector-service) */
interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type: string
}

/**
 * Renders an HTML page that sends a postMessage to the opener window and closes.
 * The origin is restricted to our app URL to prevent cross-origin leaks.
 */
function renderCallbackHtml(
  success: boolean,
  serverId: string,
  error?: string
): Response {
  const origin = getIssuerUrl()
  const payload = JSON.stringify({
    type: "mcp-oauth-callback",
    success,
    serverId,
    error: error ?? null,
  })

  const html = `<!DOCTYPE html>
<html>
<head><title>OAuth Complete</title></head>
<body>
<p>${success ? "Authorization successful. This window will close." : "Authorization failed."}</p>
<script>
  if (window.opener) {
    window.opener.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(origin)});
  }
  window.close();
</script>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}

export async function GET(req: Request): Promise<Response> {
  const requestId = generateRequestId()
  const timer = startTimer("oauth.callback")

  // Placeholder serverId for error rendering before we parse the cookie
  let serverId = ""

  try {
    // 1. Extract code and state from query params
    const { searchParams } = new URL(req.url)
    const code = searchParams.get("code")
    const state = searchParams.get("state")
    const errorParam = searchParams.get("error")

    // Handle OAuth error response from provider
    if (errorParam) {
      const errorDesc = searchParams.get("error_description") ?? errorParam
      log.warn("OAuth provider returned error", { requestId, error: errorParam, errorDesc })
      timer({ status: "error", reason: "provider_error" })
      return renderCallbackHtml(false, serverId, errorDesc)
    }

    if (!code || !state) {
      log.warn("Missing code or state in callback", { requestId })
      timer({ status: "error", reason: "missing_params" })
      return renderCallbackHtml(false, serverId, "Missing authorization code or state")
    }

    // 2. Read and decrypt state cookie
    const cookieStore = await cookies()
    const stateCookie = cookieStore.get(OAUTH_STATE_COOKIE)

    if (!stateCookie?.value) {
      log.warn("Missing OAuth state cookie", { requestId })
      timer({ status: "error", reason: "missing_cookie" })
      return renderCallbackHtml(false, serverId, "OAuth session expired. Please try again.")
    }

    let cookieData: OAuthStateCookie
    try {
      const decrypted = await decryptToken(stateCookie.value)
      cookieData = JSON.parse(decrypted) as OAuthStateCookie
    } catch (err) {
      log.warn("Failed to decrypt OAuth state cookie", { requestId, error: String(err) })
      timer({ status: "error", reason: "invalid_cookie" })
      return renderCallbackHtml(false, serverId, "Invalid OAuth session. Please try again.")
    }

    serverId = cookieData.serverId

    // 3. Validate state nonce (timing-safe comparison for CSRF prevention)
    const stateA = Buffer.from(cookieData.state, "utf8")
    const stateB = Buffer.from(state, "utf8")
    if (stateA.length !== stateB.length || !timingSafeEqual(stateA, stateB)) {
      log.warn("OAuth state mismatch", { requestId, serverId })
      timer({ status: "error", reason: "state_mismatch" })
      return renderCallbackHtml(false, serverId, "Invalid OAuth state. Please try again.")
    }

    // 4. Check cookie age
    if (Date.now() - cookieData.createdAt > STATE_MAX_AGE_MS) {
      log.warn("OAuth state cookie expired", { requestId, serverId })
      timer({ status: "error", reason: "state_expired" })
      return renderCallbackHtml(false, serverId, "OAuth session expired. Please try again.")
    }

    log.info("Processing OAuth callback", { requestId, serverId, userId: cookieData.userId })

    // 5. Clear the state cookie immediately (one-time use)
    cookieStore.delete({
      name: OAUTH_STATE_COOKIE,
      path: "/api/connectors/oauth",
    })

    // 6. Load server config
    const serverRows = await executeQuery(
      (db) =>
        db
          .select()
          .from(nexusMcpServers)
          .where(eq(nexusMcpServers.id, serverId))
          .limit(1),
      "oauth-callback:loadServer"
    )

    if (serverRows.length === 0) {
      log.error("MCP server not found during callback", { requestId, serverId })
      timer({ status: "error", reason: "server_not_found" })
      return renderCallbackHtml(false, serverId, "MCP server not found")
    }

    const server = serverRows[0]

    if (!server.credentialsKey) {
      log.error("OAuth server missing credentialsKey during callback", { requestId, serverId })
      timer({ status: "error", reason: "no_credentials_key" })
      return renderCallbackHtml(false, serverId, "Server configuration error")
    }

    // 7. Load OAuth credentials
    const credentials = await loadOAuthCredentials(server.credentialsKey)

    // 8. Build redirect URI (must match authorize request exactly)
    const baseUrl = getIssuerUrl()
    const redirectUri = `${baseUrl}/api/connectors/oauth/callback`

    // 9. Resolve token endpoint and validate against SSRF
    const tokenEndpoint = credentials.tokenEndpointUrl
      ? credentials.tokenEndpointUrl
      : new URL("/oauth/token", server.url).toString()
    validateMcpServerUrl(tokenEndpoint)

    // 10. Exchange auth code for tokens (RFC 6749 §4.1.3 + RFC 7636 §4.5)
    const tokenBody: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code_verifier: cookieData.codeVerifier,
    }

    const tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams(tokenBody),
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text().catch(() => "unknown")
      log.warn("Token exchange failed", {
        requestId,
        serverId,
        status: tokenResponse.status,
        body: errorText.slice(0, 500),
      })
      timer({ status: "error", reason: "token_exchange_failed" })
      return renderCallbackHtml(false, serverId, "Failed to exchange authorization code")
    }

    const tokenJson = await tokenResponse.json()
    const tokens = parseTokenResponse(tokenJson)

    // 11. Encrypt tokens
    const encryptedAccess = await encryptToken(tokens.access_token)
    const encryptedRefresh = tokens.refresh_token
      ? await encryptToken(tokens.refresh_token)
      : null

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null

    // 12. Upsert token row (user+server unique constraint)
    const existingRows = await executeQuery(
      (db) =>
        db
          .select({ id: nexusMcpUserTokens.id })
          .from(nexusMcpUserTokens)
          .where(
            and(
              eq(nexusMcpUserTokens.userId, cookieData.userId),
              eq(nexusMcpUserTokens.serverId, serverId)
            )
          )
          .limit(1),
      "oauth-callback:checkExisting"
    )

    if (existingRows.length > 0) {
      await executeQuery(
        (db) =>
          db
            .update(nexusMcpUserTokens)
            .set({
              encryptedAccessToken: encryptedAccess,
              encryptedRefreshToken: encryptedRefresh,
              tokenExpiresAt: expiresAt,
              scope: tokens.scope ?? null,
              updatedAt: new Date(),
            })
            .where(eq(nexusMcpUserTokens.id, existingRows[0].id)),
        "oauth-callback:updateToken"
      )
    } else {
      await executeQuery(
        (db) =>
          db.insert(nexusMcpUserTokens).values({
            userId: cookieData.userId,
            serverId,
            encryptedAccessToken: encryptedAccess,
            encryptedRefreshToken: encryptedRefresh,
            tokenExpiresAt: expiresAt,
            scope: tokens.scope ?? null,
          }),
        "oauth-callback:insertToken"
      )
    }

    timer({ status: "success" })
    log.info("OAuth callback completed successfully", {
      requestId,
      serverId,
      userId: cookieData.userId,
    })

    return renderCallbackHtml(true, serverId)
  } catch (error) {
    log.error("OAuth callback failed", { requestId, serverId, error: String(error) })
    timer({ status: "error" })
    return renderCallbackHtml(false, serverId, "An unexpected error occurred")
  }
}

/** Runtime validation for external OAuth token responses */
function parseTokenResponse(json: unknown): OAuthTokenResponse {
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
