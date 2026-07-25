/**
 * OIDC Provider Catch-All Route
 * Delegates all /api/oauth/* requests to node-oidc-provider.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 *
 * Routes handled by oidc-provider:
 * - /api/oauth/auth — Authorization endpoint
 * - /api/oauth/token — Token endpoint
 * - /api/oauth/userinfo — UserInfo endpoint
 * - /api/oauth/jwks — JWKS endpoint
 * - /api/oauth/introspection — Token introspection
 * - /api/oauth/revocation — Token revocation
 */

import { NextRequest } from "next/server"
import { getOidcProvider } from "@/lib/oauth/oidc-provider-config"
import { createLogger, generateRequestId } from "@/lib/logger"
import { invokeNodeHttpHandler } from "@/lib/oauth/node-http-adapter"

export const runtime = "nodejs"

// ============================================
// Request Adapter
// ============================================

async function handleOidcRequest(request: NextRequest): Promise<Response> {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, action: "oidc.route" })

  try {
    const provider = await getOidcProvider()
    const callback = provider.callback()

    const url = new URL(request.url)
    // Strip /api/oauth prefix to get the path oidc-provider expects
    const requestedPath = url.pathname.replace(/^\/api\/oauth/, "") || "/"
    // Preserve compatibility for clients that cached oidc-provider's previous
    // default while discovery now advertises the documented /revocation route.
    const oidcPath =
      requestedPath === "/token/revocation" ? "/revocation" : requestedPath
    return invokeNodeHttpHandler(
      request,
      oidcPath + url.search,
      callback
    )
  } catch (error) {
    log.error("OIDC route error", {
      error: error instanceof Error ? error.message : String(error),
    })

    return new Response(
      JSON.stringify({ error: "internal_server_error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
}

// ============================================
// Export handlers
// ============================================

export async function GET(request: NextRequest): Promise<Response> {
  return handleOidcRequest(request)
}

export async function POST(request: NextRequest): Promise<Response> {
  return handleOidcRequest(request)
}
