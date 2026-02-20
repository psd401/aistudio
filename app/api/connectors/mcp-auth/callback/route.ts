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

import { cookies } from "next/headers"
import { auth } from "@ai-sdk/mcp"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq } from "drizzle-orm"
import { nexusMcpServers } from "@/lib/db/schema"
import { decryptToken } from "@/lib/crypto/token-encryption"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import { validateMcpServerUrl } from "@/lib/mcp/connector-service"
import { ServerSideOAuthProvider } from "@/lib/mcp/mcp-oauth-provider"
import { getMcpAuthCookieName } from "../initiate/route"

const log = createLogger({ action: "mcp-auth-callback" })

/** Max age of the state cookie before it's considered expired (5 minutes) */
const STATE_MAX_AGE_MS = 5 * 60 * 1000

/** UUID format regex */
const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

interface McpAuthStateCookie {
  codeVerifier: string
  serverId: string
  userId: number
  createdAt: number
}

/**
 * Renders HTML that sends postMessage to opener and closes the popup.
 */
function renderCallbackHtml(
  success: boolean,
  serverId: string,
  error?: string
): Response {
  const origin = getIssuerUrl()
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
  const timer = startTimer("mcp-auth.callback")
  let serverId = ""

  try {
    // 1. Extract query params
    const { searchParams } = new URL(req.url)
    const code = searchParams.get("code")
    const errorParam = searchParams.get("error")

    // Handle OAuth error from provider
    if (errorParam) {
      log.warn("MCP OAuth provider returned error", { requestId, error: errorParam })
      timer({ status: "error", reason: "provider_error" })
      return renderCallbackHtml(false, serverId, "Authorization was denied by the provider.")
    }

    if (!code) {
      log.warn("Missing code in MCP auth callback", { requestId })
      timer({ status: "error", reason: "missing_code" })
      return renderCallbackHtml(false, serverId, "Missing authorization code")
    }

    // 2. We need to find which server this callback belongs to.
    // The @ai-sdk/mcp auth function may pass state as a query param.
    // We also check cookies for all possible server IDs that have pending auth.
    // Strategy: check state param for serverId prefix, or scan cookies.
    const state = searchParams.get("state")

    // Try to extract serverId from state (some providers pass it through)
    // The MCP SDK may encode serverId in the state, or we look at cookies
    const cookieStore = await cookies()

    // Find the matching cookie by checking all mcp_auth_state_ cookies
    let cookieData: McpAuthStateCookie | null = null

    if (state) {
      // Try state-based approach: some OAuth servers preserve state
      // Check if state contains a serverId prefix
      const colonIdx = state.indexOf(":")
      if (colonIdx === 36) {
        const stateServerId = state.slice(0, 36)
        if (UUID_RE.test(stateServerId)) {
          const cookie = cookieStore.get(getMcpAuthCookieName(stateServerId))
          if (cookie?.value) {
            try {
              const decrypted = await decryptToken(cookie.value)
              cookieData = JSON.parse(decrypted) as McpAuthStateCookie
              serverId = cookieData.serverId
            } catch {
              log.warn("Failed to decrypt MCP auth cookie from state", { requestId })
            }
          }
        }
      }
    }

    // If we couldn't find via state, scan all cookies
    if (!cookieData) {
      const allCookies = cookieStore.getAll()
      for (const cookie of allCookies) {
        if (cookie.name.startsWith("mcp_auth_state_") && cookie.value) {
          try {
            const decrypted = await decryptToken(cookie.value)
            const parsed = JSON.parse(decrypted) as McpAuthStateCookie
            // Check if this cookie is still valid (not expired)
            if (Date.now() - parsed.createdAt < STATE_MAX_AGE_MS) {
              cookieData = parsed
              serverId = parsed.serverId
              break
            }
          } catch {
            // Skip invalid cookies
          }
        }
      }
    }

    if (!cookieData) {
      log.warn("No valid MCP auth cookie found", { requestId })
      timer({ status: "error", reason: "no_cookie" })
      return renderCallbackHtml(false, serverId, "OAuth session expired. Please try again.")
    }

    // Validate cookie data
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

    log.info("Processing MCP auth callback", { requestId, serverId, userId: cookieData.userId })

    // 3. Clear the state cookie (one-time use)
    cookieStore.delete({
      name: getMcpAuthCookieName(serverId),
      path: "/api/connectors/mcp-auth",
    })

    // 4. Load server config
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
    validateMcpServerUrl(server.url)

    // 5. Create provider with pre-loaded code verifier and call auth() with code
    const baseUrl = getIssuerUrl()
    const redirectUrl = `${baseUrl}/api/connectors/mcp-auth/callback`

    const provider = new ServerSideOAuthProvider({
      serverId,
      userId: cookieData.userId,
      redirectUrl,
      preloadedCodeVerifier: cookieData.codeVerifier,
    })

    const result = await auth(provider, {
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
    log.error("MCP auth callback failed", { requestId, serverId, error: String(error) })
    timer({ status: "error" })
    return renderCallbackHtml(false, serverId, "An unexpected error occurred")
  }
}
