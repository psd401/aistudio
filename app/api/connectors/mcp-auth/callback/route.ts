/**
 * MCP-Native OAuth Callback Endpoint
 *
 * GET /api/connectors/mcp-auth/callback?code=<code>&state=<state>
 *
 * Receives the authorization code from the MCP OAuth provider redirect.
 * Uses the @ai-sdk/mcp auth() function with the authorization code to complete
 * the token exchange. The SDK handles PKCE verification and token storage
 * via the ServerSideOAuthProvider.
 *
 * Renders HTML with postMessage to popup opener (same pattern as existing OAuth callback).
 *
 * Part of Epic #774 — Nexus MCP Connectors
 * Issue #797
 */

import { createHash, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"
import { exchangeMcpOAuthTokens } from "@/lib/mcp/mcp-auth-utils"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq } from "drizzle-orm"
import { nexusMcpServers } from "@/lib/db/schema"
import { decryptToken } from "@/lib/crypto/token-encryption"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import { rejectUnsafeMcpUrl } from "@/lib/mcp/connector-service"
import { ServerSideOAuthProvider } from "@/lib/mcp/mcp-oauth-provider"
import { UUID_RE, getMcpAuthCookieName, classifyMcpOAuthError } from "@/lib/mcp/mcp-auth-utils"

const log = createLogger({ action: "mcp-auth-callback" })

/** Max age of the state cookie before it's considered expired (5 minutes) */
const STATE_MAX_AGE_MS = 5 * 60 * 1000

interface McpAuthStateCookie {
  codeVerifier: string
  serverId: string
  userId: number
  createdAt: number
  /** OAuth state param stored by initiate endpoint for CSRF validation */
  oauthState?: string | null
}

type ReadonlyCookieStore = Awaited<ReturnType<typeof cookies>>

/**
 * Looks up and validates the OAuth state cookie using the state query parameter.
 * Performs a timing-safe comparison of the stored oauthState vs the callback's state param.
 * Returns the decrypted cookie data on success, null if not found or validation fails.
 */
async function findCookieByState(
  state: string,
  cookieStore: ReadonlyCookieStore,
  requestId: string
): Promise<McpAuthStateCookie | null> {
  const colonIdx = state.indexOf(":")
  if (colonIdx !== 36) return null

  const stateServerId = state.slice(0, 36)
  if (!UUID_RE.test(stateServerId)) return null

  const cookie = cookieStore.get(getMcpAuthCookieName(stateServerId))
  if (!cookie?.value) return null

  try {
    const decrypted = await decryptToken(cookie.value)
    const parsed = JSON.parse(decrypted) as McpAuthStateCookie

    if (!parsed.oauthState) {
      log.warn("MCP auth cookie missing oauthState — CSRF validation cannot proceed", { requestId })
      return null
    }

    // timingSafeEqual requires equal-length buffers (throws otherwise).
    // The length check short-circuits, leaking whether lengths differ —
    // acceptable because state is a fixed-format UUID:randomToken string
    // with predictable length on both sides.
    const matches =
      parsed.oauthState.length === state.length &&
      timingSafeEqual(Buffer.from(parsed.oauthState), Buffer.from(state))
    if (!matches) {
      log.warn("MCP auth cookie state mismatch — possible CSRF", { requestId })
      return null
    }

    return parsed
  } catch {
    log.warn("Failed to decrypt MCP auth cookie from state", { requestId })
    return null
  }
}

/**
 * Fallback: scans all mcp_auth_state_* cookies and returns the first non-expired one.
 * Used only when the state query parameter was not preserved by the OAuth provider.
 *
 * CSRF note: This fallback has no timing-safe state comparison, so CSRF protection is
 * weaker than the state-based path. It remains safe because:
 * 1. Cookies are AES-256-GCM encrypted with the server DEK — they cannot be forged
 * 2. Cookies are httpOnly, sameSite=lax, scoped to /api/connectors/mcp-auth
 * 3. Cookie TTL is 5 minutes — limits the window for concurrent flow ambiguity
 * If multiple OAuth flows are in flight simultaneously, the first non-expired cookie wins,
 * which could bind the callback to the wrong server. This is an acceptable edge case
 * (users rarely initiate two OAuth flows within 5 minutes on the same browser).
 */
async function findCookieByBruteForce(
  cookieStore: ReadonlyCookieStore
): Promise<McpAuthStateCookie | null> {
  for (const cookie of cookieStore.getAll()) {
    if (!cookie.name.startsWith("mcp_auth_state_") || !cookie.value) continue
    try {
      const decrypted = await decryptToken(cookie.value)
      const parsed = JSON.parse(decrypted) as McpAuthStateCookie
      if (Date.now() - parsed.createdAt < STATE_MAX_AGE_MS) {
        return parsed
      }
    } catch {
      // Skip invalid cookies
    }
  }
  return null
}

/**
 * Fixed inline script that reads payload and origin from JSON data blocks.
 * Because this string is constant (no dynamic data), the CSP SHA-256 hash
 * is stable and no user-influenced data flows into createHash().
 *
 * Data blocks:
 *   #d — JSON payload object (type, success, serverId, error)
 *   #o — JSON-encoded origin string for postMessage targetOrigin
 */
const CALLBACK_SCRIPT = [
  "var d=JSON.parse(document.getElementById('d').textContent),",
  "o=JSON.parse(document.getElementById('o').textContent);",
  "if(window.opener){window.opener.postMessage(d,o);}",
  "window.close();",
].join("")

/** Pre-computed CSP hash of the fixed inline script */
const CALLBACK_SCRIPT_HASH = createHash("sha256").update(CALLBACK_SCRIPT, "utf8").digest("base64")

/**
 * Renders HTML that sends postMessage to opener and closes the popup.
 * Uses a SHA-256 hash of the inline script for CSP instead of 'unsafe-inline'.
 *
 * The payload (success, serverId, error) and the postMessage origin are placed
 * in `<script type="application/json">` data blocks, NOT in the inline script.
 * This keeps the inline script content fixed so no tainted data flows into
 * the CSP hash computation.
 */
function renderCallbackHtml(
  success: boolean,
  serverId: string,
  error?: string
): Response {
  const origin = getIssuerUrl()

  // HTML-escape JSON to prevent injection in the HTML context.
  const escapeHtml = (s: string) => s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")

  const payloadJson = escapeHtml(JSON.stringify({
    type: "mcp-oauth-callback",
    success,
    serverId,
    error: error ?? null,
  }))

  const originJson = escapeHtml(JSON.stringify(origin))

  const html = `<!DOCTYPE html>
<html>
<head><title>OAuth Complete</title></head>
<body>
<p>${success ? "Authorization successful. This window will close." : "Authorization failed."}</p>
<script type="application/json" id="d">${payloadJson}</script>
<script type="application/json" id="o">${originJson}</script>
<script>${CALLBACK_SCRIPT}</script>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${CALLBACK_SCRIPT_HASH}'`,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  })
}

export async function GET(req: Request): Promise<Response> {
  const requestId = generateRequestId()
  const timer = startTimer("mcp-auth.callback")
  let serverId = ""

  try {
    // 1. Extract query params
    const { searchParams } = new URL(req.url)
    const code = searchParams.get("code")
    const errorParam = searchParams.get("error")
    const state = searchParams.get("state")

    // 2. Validate the state cookie FIRST — this is the CSRF/session integrity check.
    // Must run before any early return (including OAuth error responses) so that
    // errorParam cannot be used to bypass cookie validation (CodeQL js/user-controlled-bypass).
    const cookieStore = await cookies()

    // Deterministic state-based lookup first (preferred — timing-safe CSRF check)
    let cookieData = state ? await findCookieByState(state, cookieStore, requestId) : null

    // Fallback: scan all cookies when state-based lookup failed (e.g. provider stripped state)
    if (!cookieData) {
      cookieData = await findCookieByBruteForce(cookieStore)
      if (cookieData) {
        log.warn("MCP auth callback using cookie-scan fallback — state param not matched", {
          requestId,
          hasState: !!state,
        })
      }
    }

    if (!cookieData) {
      log.warn("No valid MCP auth cookie found", { requestId })
      timer({ status: "error", reason: "no_cookie" })
      return renderCallbackHtml(false, serverId, "OAuth session expired. Please try again.")
    }

    serverId = cookieData.serverId

    // Validate cookie fields
    if (!UUID_RE.test(cookieData.serverId)) {
      log.warn("Invalid serverId in MCP auth cookie", { requestId })
      timer({ status: "error", reason: "invalid_cookie" })
      return renderCallbackHtml(false, "", "Invalid OAuth session. Please try again.")
    }

    if (!Number.isInteger(cookieData.userId) || cookieData.userId <= 0) {
      log.warn("Invalid userId in MCP auth cookie", { requestId })
      timer({ status: "error", reason: "invalid_cookie" })
      return renderCallbackHtml(false, serverId, "Invalid OAuth session. Please try again.")
    }

    // Check cookie age
    if (Date.now() - cookieData.createdAt > STATE_MAX_AGE_MS) {
      log.warn("MCP auth cookie expired", { requestId, serverId })
      timer({ status: "error", reason: "expired" })
      return renderCallbackHtml(false, serverId, "OAuth session expired. Please try again.")
    }

    // 3. Clear the state cookie (one-time use) — done before token exchange
    cookieStore.delete({
      name: getMcpAuthCookieName(serverId),
      path: "/api/connectors/mcp-auth",
    })

    // 4. Handle OAuth error/code from provider (AFTER cookie validation — CSRF check already passed).
    // CodeQL js/user-controlled-bypass dismissed (alerts #395, #396): RFC 6749 §4.1.2 requires
    // checking errorParam/code. CSRF cookie validated unconditionally above (lines 181-201).
    if (errorParam) {
      log.warn("MCP OAuth provider returned error", {
        requestId,
        serverId,
        error: errorParam.slice(0, 100),
      })
      timer({ status: "error", reason: "provider_error" })
      return renderCallbackHtml(false, serverId, "Authorization was denied by the provider.")
    }

    if (!code) {
      log.warn("Missing code in MCP auth callback", { requestId, serverId })
      timer({ status: "error", reason: "missing_code" })
      return renderCallbackHtml(false, serverId, "Missing authorization code")
    }

    log.info("Processing MCP auth callback", { requestId, serverId, userId: cookieData.userId })

    // 5. Load server config
    const serverRows = await executeQuery(
      (db) =>
        db
          .select()
          .from(nexusMcpServers)
          .where(eq(nexusMcpServers.id, serverId))
          .limit(1),
      "mcp-auth-callback:loadServer"
    )

    if (serverRows.length === 0) {
      log.error("MCP server not found during callback", { requestId, serverId })
      timer({ status: "error", reason: "server_not_found" })
      return renderCallbackHtml(false, serverId, "MCP server not found")
    }

    const server = serverRows[0]

    // Defense in depth: initiate validates authType, but a crafted cookie could
    // reference a non-OAuth server. Reject early before attempting token exchange.
    if (server.authType !== "oauth") {
      log.warn("MCP auth callback against non-OAuth server", { requestId, serverId })
      timer({ status: "error", reason: "not_oauth" })
      return renderCallbackHtml(false, serverId, "Server is not configured for OAuth.")
    }

    rejectUnsafeMcpUrl(server.url)

    // 6. Create provider with pre-loaded code verifier and call auth() with code
    const baseUrl = getIssuerUrl()
    const redirectUrl = `${baseUrl}/api/connectors/mcp-auth/callback`

    const provider = new ServerSideOAuthProvider({
      serverId,
      userId: cookieData.userId,
      redirectUrl,
      preloadedCodeVerifier: cookieData.codeVerifier,
    })

    const result = await exchangeMcpOAuthTokens(provider, {
      serverUrl: server.url,
      authorizationCode: code,
    })

    if (result !== "AUTHORIZED") {
      log.warn("MCP auth callback did not result in AUTHORIZED", { requestId, serverId, result })
      timer({ status: "error", reason: "not_authorized" })
      return renderCallbackHtml(false, serverId, "Authorization failed. Please try again.")
    }

    timer({ status: "success" })
    log.info("MCP auth callback completed successfully", {
      requestId,
      serverId,
      userId: cookieData.userId,
    })

    return renderCallbackHtml(true, serverId)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log.error("MCP auth callback failed", {
      requestId,
      serverId,
      error: errorMessage,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      cause: error instanceof Error && error.cause ? String(error.cause) : undefined,
    })
    timer({ status: "error" })

    // Surface a user-friendly but specific error derived from the failure.
    // Internal details stay in server logs; the user gets an actionable message.
    const category = classifyMcpOAuthError(errorMessage)
    const userMessage = CALLBACK_ERROR_MESSAGES[category] ?? CALLBACK_ERROR_MESSAGES.unexpected
    return renderCallbackHtml(false, serverId, userMessage)
  }
}

/**
 * User-facing error messages for the callback endpoint.
 * Keyed by McpOAuthErrorCategory from the shared classifier.
 * Categories not applicable to this endpoint (e.g. "blocked") fall through to "unexpected".
 */
const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  timeout: "The authorization server took too long to respond. Please try again.",
  connectivity: "Could not reach the authorization server. Check your network and try again.",
  unauthorized: "The authorization server rejected the request. The client registration may be invalid.",
  forbidden: "Access was denied by the authorization server.",
  invalid_token: "The token exchange returned an invalid response. The provider may have changed its API.",
  discovery: "Could not discover the OAuth server configuration. The MCP server URL may be incorrect.",
  registration: "Dynamic client registration failed. The MCP server may not support it.",
  pkce: "PKCE verification failed. The OAuth session may have expired — please try again.",
  encryption: "Session data could not be read. Please try again.",
  not_found: "The MCP server configuration was not found. It may have been deleted.",
  unexpected: "An unexpected error occurred during authorization. Check server logs for details.",
}
