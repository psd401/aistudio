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
import { z } from "zod"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, sql } from "drizzle-orm"
import { nexusMcpServers, nexusMcpUserTokens } from "@/lib/db/schema"
import { loadOAuthCredentials, validateMcpServerUrl } from "@/lib/mcp/connector-service"
import { encryptToken, decryptToken } from "@/lib/crypto/token-encryption"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import { getOAuthStateCookieName } from "../authorize/route"

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

/** Zod schema for external OAuth token responses (RFC 6749 §5.1) */
const oauthTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  refresh_token: z.string().optional(),
  // Some providers (GitHub, Azure) return expires_in as a numeric string
  expires_in: z.union([
    z.number(),
    z.string().transform((s) => (s !== "" ? Number(s) || undefined : undefined)),
  ]).optional(),
  scope: z.string().optional(),
})

type OAuthTokenResponse = z.infer<typeof oauthTokenResponseSchema>

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
  // Escape '<' to prevent </script> injection; embed as JS object (not a string)
  const payloadJson = JSON.stringify({
    type: "mcp-oauth-callback",
    success,
    serverId,
    error: error ?? null,
  }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")

  const html = `<!DOCTYPE html>
<html>
<head><title>OAuth Complete</title></head>
<body>
<p>${success ? "Authorization successful. This window will close." : "Authorization failed."}</p>
<script>
  if (window.opener) {
    window.opener.postMessage(${payloadJson}, ${JSON.stringify(origin)});
  }
  window.close();
</script>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
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
      // Use static message in HTML to prevent XSS from provider-controlled error_description
      return renderCallbackHtml(false, serverId, "Authorization was denied by the provider.")
    }

    if (!code || !state) {
      log.warn("Missing code or state in callback", { requestId })
      timer({ status: "error", reason: "missing_params" })
      return renderCallbackHtml(false, serverId, "Missing authorization code or state")
    }

    // 2. Extract serverId from state (format: "serverId:nonce") to find per-server cookie
    const colonIdx = state.indexOf(":")
    if (colonIdx !== 36) {
      log.warn("Invalid state format in callback", { requestId })
      timer({ status: "error", reason: "invalid_state_format" })
      return renderCallbackHtml(false, serverId, "Invalid OAuth state. Please try again.")
    }
    const stateServerId = state.slice(0, 36)

    // Validate stateServerId format before using it in cookie lookup or error rendering
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(stateServerId)) {
      log.warn("Invalid serverId in state parameter", { requestId })
      timer({ status: "error", reason: "invalid_state_server_id" })
      return renderCallbackHtml(false, "", "Invalid OAuth state. Please try again.")
    }

    // 3. Read and decrypt per-server state cookie
    const cookieStore = await cookies()
    const cookieName = getOAuthStateCookieName(stateServerId)
    const stateCookie = cookieStore.get(cookieName)

    if (!stateCookie?.value) {
      log.warn("Missing OAuth state cookie", { requestId, cookieName })
      timer({ status: "error", reason: "missing_cookie" })
      return renderCallbackHtml(false, stateServerId, "OAuth session expired. Please try again.")
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

    // Defense-in-depth: validate cookie data before use in DB queries or HTML
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(serverId)) {
      log.warn("Invalid serverId in OAuth state cookie", { requestId })
      timer({ status: "error", reason: "invalid_cookie_data" })
      return renderCallbackHtml(false, "", "Invalid OAuth session. Please try again.")
    }
    if (!Number.isInteger(cookieData.userId) || cookieData.userId <= 0) {
      log.warn("Invalid userId in OAuth state cookie", { requestId })
      timer({ status: "error", reason: "invalid_cookie_data" })
      return renderCallbackHtml(false, serverId, "Invalid OAuth session. Please try again.")
    }

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

    // Note: we do NOT re-authenticate via getCurrentUserAction() here. The callback
    // arrives as a redirect from the OAuth provider, and the popup may not carry the
    // full session cookie jar in all browsers. We rely on cookieData.userId from the
    // encrypted state cookie (set during authorize). If the user is deleted in the
    // ~5 min window, the users FK with onDelete:"cascade" handles cleanup.
    log.info("Processing OAuth callback", { requestId, serverId, userId: cookieData.userId })

    // 5. Clear the state cookie immediately (one-time use)
    cookieStore.delete({
      name: cookieName,
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
    let tokenEndpoint: string
    if (credentials.tokenEndpointUrl) {
      tokenEndpoint = credentials.tokenEndpointUrl
    } else {
      // Fallback: resolve /oauth/token from the server's origin (not path).
      // new URL("/oauth/token", "https://host/mcp/v1") → "https://host/oauth/token"
      // This discards any path segments in server.url — providers requiring a
      // path-relative token endpoint must set tokenEndpointUrl explicitly.
      tokenEndpoint = new URL("/oauth/token", server.url).toString()
      log.warn("No tokenEndpointUrl configured — falling back to /oauth/token", {
        requestId,
        serverId,
        fallbackUrl: tokenEndpoint,
      })
    }
    validateMcpServerUrl(tokenEndpoint)

    // 10. Exchange auth code for tokens (RFC 6749 §4.1.3 + RFC 7636 §4.5)
    // Uses client_secret_post method (secret in body). Providers requiring
    // client_secret_basic (HTTP Basic auth) are not supported yet.
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

    // 12. Atomic upsert token row (user+server unique constraint)
    await executeQuery(
      (db) =>
        db
          .insert(nexusMcpUserTokens)
          .values({
            userId: cookieData.userId,
            serverId,
            encryptedAccessToken: encryptedAccess,
            encryptedRefreshToken: encryptedRefresh,
            tokenExpiresAt: expiresAt,
            scope: tokens.scope ?? null,
          })
          .onConflictDoUpdate({
            target: [nexusMcpUserTokens.userId, nexusMcpUserTokens.serverId],
            set: {
              encryptedAccessToken: encryptedAccess,
              encryptedRefreshToken: encryptedRefresh,
              tokenExpiresAt: expiresAt,
              scope: tokens.scope ?? null,
              updatedAt: sql`NOW()`,
            },
          }),
      "oauth-callback:upsertToken"
    )

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

/** Runtime validation for external OAuth token responses using Zod */
function parseTokenResponse(json: unknown): OAuthTokenResponse {
  const result = oauthTokenResponseSchema.safeParse(json)
  if (!result.success) {
    throw new Error(`Invalid OAuth token response: ${result.error.issues[0]?.message ?? "unknown"}`)
  }
  return result.data
}
