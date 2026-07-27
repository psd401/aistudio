/**
 * OAuth callback for MCP connectors.
 *
 * The encrypted, one-time state cookie is validated before provider errors or
 * authorization codes are handled. The callback then exchanges the PKCE code,
 * encrypts the resulting tokens, and atomically stores them for the user.
 */

import { createHash, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"
import { eq, sql } from "drizzle-orm"
import { decryptToken, encryptToken } from "@/lib/crypto/token-encryption"
import { executeQuery } from "@/lib/db/drizzle-client"
import { nexusMcpServers, nexusMcpUserTokens } from "@/lib/db/schema"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import {
  loadOAuthCredentials,
  rejectUnsafeMcpUrl,
} from "@/lib/mcp/connector-service"
import { UUID_RE } from "@/lib/mcp/mcp-auth-utils"
import { getOAuthStateCookieName } from "@/lib/mcp/oauth-state"
import { getIssuerUrl } from "@/lib/oauth/issuer-config"
import { safeFetch } from "@/lib/security/safe-fetch"
import {
  parseTokenResponse,
  type OAuthTokenResponse,
} from "./token-response"

const log = createLogger({ action: "oauth-callback" })
const STATE_MAX_AGE_MS = 5 * 60 * 1000

interface OAuthStateCookie {
  state: string
  codeVerifier: string
  serverId: string
  userId: number
  createdAt: number
}

interface CallbackContext {
  code: string
  cookieData: OAuthStateCookie
  requestId: string
  serverId: string
}

type CallbackTimer = ReturnType<typeof startTimer>
type McpServer = typeof nexusMcpServers.$inferSelect
type OAuthCredentials = Awaited<ReturnType<typeof loadOAuthCredentials>>
type CallbackResolution =
  | { ok: true; context: CallbackContext }
  | { ok: false; response: Response }
type StateResolution =
  | {
      ok: true
      cookieData: OAuthStateCookie
      cookieName: string
      serverId: string
      cookieStore: Awaited<ReturnType<typeof cookies>>
    }
  | { ok: false; response: Response }

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

async function validateStateCookie(
  state: string,
  stateServerId: string,
  requestId: string,
  timer: CallbackTimer
): Promise<StateResolution> {
  const cookieStore = await cookies()
  const cookieName = getOAuthStateCookieName(stateServerId)
  const stateCookie = cookieStore.get(cookieName)
  if (!stateCookie?.value) {
    return {
      ok: false,
      response: callbackFailure(
        timer,
        "missing_cookie",
        stateServerId,
        "OAuth session expired. Please try again."
      ),
    }
  }

  let cookieData: OAuthStateCookie
  try {
    cookieData = JSON.parse(
      await decryptToken(stateCookie.value)
    ) as OAuthStateCookie
  } catch (error) {
    log.warn("Failed to decrypt OAuth state cookie", {
      requestId,
      error: String(error),
    })
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

  const serverId = cookieData.serverId
  const validIdentity =
    UUID_RE.test(serverId) &&
    Number.isInteger(cookieData.userId) &&
    cookieData.userId > 0
  if (!validIdentity) {
    return {
      ok: false,
      response: callbackFailure(
        timer,
        "invalid_cookie_data",
        UUID_RE.test(serverId) ? serverId : "",
        "Invalid OAuth session. Please try again."
      ),
    }
  }

  const storedState = Buffer.from(cookieData.state, "utf8")
  const callbackState = Buffer.from(state, "utf8")
  const stateMatches =
    storedState.length === callbackState.length &&
    timingSafeEqual(storedState, callbackState)
  if (!stateMatches) {
    return {
      ok: false,
      response: callbackFailure(
        timer,
        "state_mismatch",
        serverId,
        "Invalid OAuth state. Please try again."
      ),
    }
  }
  if (Date.now() - cookieData.createdAt > STATE_MAX_AGE_MS) {
    return {
      ok: false,
      response: callbackFailure(
        timer,
        "state_expired",
        serverId,
        "OAuth session expired. Please try again."
      ),
    }
  }
  return { ok: true, cookieData, cookieName, serverId, cookieStore }
}

async function resolveCallback(
  req: Request,
  requestId: string,
  timer: CallbackTimer
): Promise<CallbackResolution> {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const errorParam = searchParams.get("error")
  if (!state || state.indexOf(":") !== 36) {
    return {
      ok: false,
      response: callbackFailure(
        timer,
        "invalid_state_format",
        "",
        "Invalid OAuth state. Please try again."
      ),
    }
  }

  const stateServerId = state.slice(0, 36)
  if (!UUID_RE.test(stateServerId)) {
    return {
      ok: false,
      response: callbackFailure(
        timer,
        "invalid_state_server_id",
        "",
        "Invalid OAuth state. Please try again."
      ),
    }
  }

  const stateResolution = await validateStateCookie(
    state,
    stateServerId,
    requestId,
    timer
  )
  if (!stateResolution.ok) return stateResolution
  const { cookieData, cookieName, cookieStore, serverId } = stateResolution
  cookieStore.delete({
    name: cookieName,
    path: "/api/connectors/oauth",
  })
  if (errorParam) {
    const errorDescription =
      searchParams.get("error_description") ?? errorParam
    log.warn("OAuth provider returned error", {
      requestId,
      error: errorParam,
      errorDescription,
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
        "missing_params",
        serverId,
        "Missing authorization code or state"
      ),
    }
  }

  log.info("Processing OAuth callback", {
    requestId,
    serverId,
    userId: cookieData.userId,
  })
  return {
    ok: true,
    context: { code, cookieData, requestId, serverId },
  }
}

async function loadServer(serverId: string): Promise<McpServer | null> {
  const rows = await executeQuery(
    db =>
      db
        .select()
        .from(nexusMcpServers)
        .where(eq(nexusMcpServers.id, serverId))
        .limit(1),
    "oauth-callback:loadServer"
  )
  return rows[0] ?? null
}

function resolveTokenEndpoint(
  credentials: OAuthCredentials,
  server: McpServer,
  context: CallbackContext
): string {
  if (credentials.tokenEndpointUrl) return credentials.tokenEndpointUrl

  const tokenEndpoint = new URL("/oauth/token", server.url).toString()
  log.warn("No tokenEndpointUrl configured — falling back to /oauth/token", {
    requestId: context.requestId,
    serverId: context.serverId,
    fallbackUrl: tokenEndpoint,
  })
  return tokenEndpoint
}

async function requestTokens(
  credentials: OAuthCredentials,
  server: McpServer,
  context: CallbackContext,
  timer: CallbackTimer
): Promise<OAuthTokenResponse | Response> {
  const tokenEndpoint = resolveTokenEndpoint(credentials, server, context)
  rejectUnsafeMcpUrl(tokenEndpoint)
  const redirectUri = `${getIssuerUrl()}/api/connectors/oauth/callback`
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: context.code,
    redirect_uri: redirectUri,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code_verifier: context.cookieData.codeVerifier,
  }).toString()
  const response = await safeFetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(15_000),
    body,
  })
  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown")
    log.warn("Token exchange failed", {
      requestId: context.requestId,
      serverId: context.serverId,
      status: response.status,
      body: errorText.slice(0, 500),
    })
    return callbackFailure(
      timer,
      "token_exchange_failed",
      context.serverId,
      "Failed to exchange authorization code"
    )
  }
  return parseTokenResponse(await response.json())
}

async function storeTokens(
  tokens: OAuthTokenResponse,
  context: CallbackContext
): Promise<void> {
  const encryptedAccess = await encryptToken(tokens.access_token)
  const encryptedRefresh = tokens.refresh_token
    ? await encryptToken(tokens.refresh_token)
    : null
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null

  await executeQuery(
    db =>
      db
        .insert(nexusMcpUserTokens)
        .values({
          userId: context.cookieData.userId,
          serverId: context.serverId,
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
  if (!server.credentialsKey) {
    return callbackFailure(
      timer,
      "no_credentials_key",
      context.serverId,
      "Server configuration error"
    )
  }

  const credentials = await loadOAuthCredentials(
    server.credentialsKey,
    server.url
  )
  const result = await requestTokens(credentials, server, context, timer)
  if (result instanceof Response) return result
  await storeTokens(result, context)
  timer({ status: "success" })
  log.info("OAuth callback completed successfully", {
    requestId: context.requestId,
    serverId: context.serverId,
    userId: context.cookieData.userId,
  })
  return renderCallbackHtml(true, context.serverId)
}

export async function GET(req: Request): Promise<Response> {
  const requestId = generateRequestId()
  const timer = startTimer("oauth.callback")
  let serverId = ""

  try {
    const resolution = await resolveCallback(req, requestId, timer)
    if (!resolution.ok) return resolution.response
    serverId = resolution.context.serverId
    return await completeCallback(resolution.context, timer)
  } catch (error) {
    log.error("OAuth callback failed", {
      requestId,
      serverId,
      error: String(error),
    })
    timer({ status: "error" })
    return renderCallbackHtml(false, serverId, "An unexpected error occurred")
  }
}
