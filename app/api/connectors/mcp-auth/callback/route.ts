/**
 * MCP-native OAuth callback.
 *
 * The encrypted, one-time state cookie is always validated before provider
 * errors or authorization codes are handled. Token endpoints remain subject to
 * the same SSRF guard as refresh-token exchange.
 */

import { createHash, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"
import { eq } from "drizzle-orm"
import { decryptToken } from "@/lib/crypto/token-encryption"
import { executeQuery } from "@/lib/db/drizzle-client"
import { nexusMcpServers } from "@/lib/db/schema"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import {
  getOAuthCredentials,
  rejectUnsafeMcpUrl,
} from "@/lib/mcp/connector-service"
import {
  classifyMcpOAuthError,
  getMcpAuthCookieName,
  UUID_RE,
} from "@/lib/mcp/mcp-auth-utils"
import { ServerSideOAuthProvider } from "@/lib/mcp/mcp-oauth-provider"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import { safeFetch } from "@/lib/security/safe-fetch"
import { parsePreRegisteredTokens } from "./token-response"

const log = createLogger({ action: "mcp-auth-callback" })
const STATE_MAX_AGE_MS = 5 * 60 * 1000

interface McpAuthStateCookie {
  codeVerifier: string
  serverId: string
  userId: number
  createdAt: number
  oauthState?: string | null
}

type ReadonlyCookieStore = Awaited<ReturnType<typeof cookies>>
type CallbackTimer = ReturnType<typeof startTimer>
type McpServer = typeof nexusMcpServers.$inferSelect
type OAuthCredentials = NonNullable<
  Awaited<ReturnType<typeof getOAuthCredentials>>
>

interface CallbackContext {
  code: string
  cookieData: McpAuthStateCookie
  requestId: string
  serverId: string
}

type CallbackResolution =
  | { ok: true; context: CallbackContext }
  | { ok: false; response: Response }

async function findCookieByState(
  state: string,
  cookieStore: ReadonlyCookieStore,
  requestId: string
): Promise<McpAuthStateCookie | null> {
  const colonIndex = state.indexOf(":")
  if (colonIndex !== 36) return null

  const stateServerId = state.slice(0, 36)
  if (!UUID_RE.test(stateServerId)) return null

  const cookie = cookieStore.get(getMcpAuthCookieName(stateServerId))
  if (!cookie?.value) return null

  try {
    const decrypted = await decryptToken(cookie.value)
    const parsed = JSON.parse(decrypted) as McpAuthStateCookie
    if (!parsed.oauthState) {
      log.warn("MCP auth cookie missing oauthState", { requestId })
      return null
    }
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

async function findCookieByBruteForce(
  cookieStore: ReadonlyCookieStore
): Promise<McpAuthStateCookie | null> {
  for (const cookie of cookieStore.getAll()) {
    if (!cookie.name.startsWith("mcp_auth_state_") || !cookie.value) continue
    try {
      const decrypted = await decryptToken(cookie.value)
      const parsed = JSON.parse(decrypted) as McpAuthStateCookie
      if (Date.now() - parsed.createdAt < STATE_MAX_AGE_MS) return parsed
    } catch {
      // Ignore malformed or undecryptable cookies.
    }
  }
  return null
}

const CALLBACK_SCRIPT = [
  "var d=JSON.parse(document.getElementById('d').textContent),",
  "o=JSON.parse(document.getElementById('o').textContent);",
  "if(window.opener){window.opener.postMessage(d,o);}",
  "window.close();",
].join("")

const CALLBACK_SCRIPT_HASH = createHash("sha256")
  .update(CALLBACK_SCRIPT, "utf8")
  .digest("base64")

function escapeHtmlJson(value: string): string {
  return value
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
}

function renderCallbackHtml(
  success: boolean,
  serverId: string,
  error?: string
): Response {
  const payloadJson = escapeHtmlJson(
    JSON.stringify({
      type: "mcp-oauth-callback",
      success,
      serverId,
      error: error ?? null,
    })
  )
  const originJson = escapeHtmlJson(JSON.stringify(getIssuerUrl()))
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
      "Content-Security-Policy":
        `default-src 'none'; script-src 'sha256-${CALLBACK_SCRIPT_HASH}'`,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  })
}

function callbackFailure(
  timer: CallbackTimer,
  reason: string,
  serverId: string,
  message: string
): Response {
  timer({ status: "error", reason })
  return renderCallbackHtml(false, serverId, message)
}

async function resolveCallback(
  req: Request,
  requestId: string,
  timer: CallbackTimer
): Promise<CallbackResolution> {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get("code")
  const errorParam = searchParams.get("error")
  const state = searchParams.get("state")
  const cookieStore = await cookies()

  let cookieData = state
    ? await findCookieByState(state, cookieStore, requestId)
    : null
  if (!cookieData) {
    cookieData = await findCookieByBruteForce(cookieStore)
    if (cookieData) {
      log.warn("MCP auth callback using cookie-scan fallback", {
        requestId,
        hasState: !!state,
      })
    }
  }
  if (!cookieData) {
    log.warn("No valid MCP auth cookie found", { requestId })
    return {
      ok: false,
      response: callbackFailure(
        timer,
        "no_cookie",
        "",
        "OAuth session expired. Please try again."
      ),
    }
  }

  const serverId = cookieData.serverId
  if (!UUID_RE.test(serverId)) {
    return {
      ok: false,
      response: callbackFailure(
        timer,
        "invalid_cookie",
        "",
        "Invalid OAuth session. Please try again."
      ),
    }
  }
  if (!Number.isInteger(cookieData.userId) || cookieData.userId <= 0) {
    return {
      ok: false,
      response: callbackFailure(
        timer,
        "invalid_cookie",
        serverId,
        "Invalid OAuth session. Please try again."
      ),
    }
  }
  if (Date.now() - cookieData.createdAt > STATE_MAX_AGE_MS) {
    return {
      ok: false,
      response: callbackFailure(
        timer,
        "expired",
        serverId,
        "OAuth session expired. Please try again."
      ),
    }
  }

  cookieStore.delete({
    name: getMcpAuthCookieName(serverId),
    path: "/api/connectors/mcp-auth",
  })
  if (errorParam) {
    log.warn("MCP OAuth provider returned error", {
      requestId,
      serverId,
      error: errorParam.slice(0, 100),
    })
    return {
      ok: false,
      response: callbackFailure(
        timer,
        "provider_error",
        serverId,
        "Authorization was denied by the provider."
      ),
    }
  }
  if (!code) {
    return {
      ok: false,
      response: callbackFailure(
        timer,
        "missing_code",
        serverId,
        "Missing authorization code"
      ),
    }
  }
  return {
    ok: true,
    context: { code, cookieData, requestId, serverId },
  }
}

function createTokenRequest(
  credentials: OAuthCredentials,
  context: CallbackContext,
  redirectUrl: string
): { body: string; headers: Record<string, string> } {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: context.code,
    redirect_uri: redirectUrl,
    code_verifier: context.cookieData.codeVerifier,
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  }
  if (credentials.clientId && credentials.clientSecret) {
    headers.Authorization =
      `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`
  } else {
    if (credentials.clientId) body.client_id = credentials.clientId
    if (credentials.clientSecret) body.client_secret = credentials.clientSecret
  }
  return { body: new URLSearchParams(body).toString(), headers }
}

async function exchangeAndStoreTokens(
  credentials: OAuthCredentials,
  context: CallbackContext,
  redirectUrl: string,
  timer: CallbackTimer
): Promise<Response> {
  if (!credentials.tokenEndpointUrl) {
    return callbackFailure(
      timer,
      "missing_token_endpoint",
      context.serverId,
      "OAuth credentials are missing the token endpoint URL."
    )
  }
  rejectUnsafeMcpUrl(credentials.tokenEndpointUrl)
  const request = createTokenRequest(credentials, context, redirectUrl)
  const response = await safeFetch(credentials.tokenEndpointUrl, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const responseBody = await response.text().catch(() => "(unreadable)")
    log.error("Pre-registered OAuth token exchange failed", {
      requestId: context.requestId,
      serverId: context.serverId,
      status: response.status,
      body: responseBody.slice(0, 500),
    })
    return callbackFailure(
      timer,
      "token_exchange_failed",
      context.serverId,
      "Token exchange failed. Please try again."
    )
  }

  const tokens = parsePreRegisteredTokens(await response.json())
  if (!tokens) {
    return callbackFailure(
      timer,
      "invalid_token_response",
      context.serverId,
      "Invalid token response from provider."
    )
  }
  const provider = new ServerSideOAuthProvider({
    serverId: context.serverId,
    userId: context.cookieData.userId,
    redirectUrl,
  })
  await provider.saveTokens(tokens)
  timer({ status: "success" })
  log.info("Pre-registered OAuth callback completed successfully", {
    requestId: context.requestId,
    serverId: context.serverId,
    userId: context.cookieData.userId,
  })
  return renderCallbackHtml(true, context.serverId)
}

async function loadServer(serverId: string): Promise<McpServer | null> {
  const rows = await executeQuery(
    db =>
      db
        .select()
        .from(nexusMcpServers)
        .where(eq(nexusMcpServers.id, serverId))
        .limit(1),
    "mcp-auth-callback:loadServer"
  )
  return rows[0] ?? null
}

async function completeCallback(
  context: CallbackContext,
  timer: CallbackTimer
): Promise<Response> {
  const server = await loadServer(context.serverId)
  if (!server) {
    return callbackFailure(
      timer,
      "server_not_found",
      context.serverId,
      "MCP server not found"
    )
  }
  if (server.authType !== "oauth") {
    return callbackFailure(
      timer,
      "not_oauth",
      context.serverId,
      "Server is not configured for OAuth."
    )
  }
  rejectUnsafeMcpUrl(server.url)
  const credentials = await getOAuthCredentials(server)
  if (!credentials) {
    return callbackFailure(
      timer,
      "preregistered_oauth_required",
      context.serverId,
      "This connector must be configured with pre-registered OAuth endpoints."
    )
  }
  const redirectUrl = `${getIssuerUrl()}/api/connectors/mcp-auth/callback`
  return exchangeAndStoreTokens(credentials, context, redirectUrl, timer)
}

const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  timeout:
    "The authorization server took too long to respond. Please try again.",
  connectivity:
    "Could not reach the authorization server. Check your network and try again.",
  unauthorized:
    "The authorization server rejected the request. The client registration may be invalid.",
  forbidden: "Access was denied by the authorization server.",
  invalid_token:
    "The token exchange returned an invalid response. The provider may have changed its API.",
  discovery:
    "Could not discover the OAuth server configuration. The MCP server URL may be incorrect.",
  registration:
    "Dynamic client registration failed. The MCP server may not support it.",
  pkce:
    "PKCE verification failed. The OAuth session may have expired — please try again.",
  encryption: "Session data could not be read. Please try again.",
  not_found:
    "The MCP server configuration was not found. It may have been deleted.",
  unexpected:
    "An unexpected error occurred during authorization. Check server logs for details.",
}

export async function GET(req: Request): Promise<Response> {
  const requestId = generateRequestId()
  const timer = startTimer("mcp-auth.callback")
  let serverId = ""

  try {
    const resolution = await resolveCallback(req, requestId, timer)
    if (!resolution.ok) return resolution.response
    serverId = resolution.context.serverId
    return await completeCallback(resolution.context, timer)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log.error("MCP auth callback failed", {
      requestId,
      serverId,
      error: errorMessage,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      cause:
        error instanceof Error && error.cause
          ? String(error.cause)
          : undefined,
    })
    timer({ status: "error" })
    const category = classifyMcpOAuthError(errorMessage)
    const message =
      CALLBACK_ERROR_MESSAGES[category] ?? CALLBACK_ERROR_MESSAGES.unexpected
    return renderCallbackHtml(false, serverId, message)
  }
}
