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
import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import { getOidcProvider } from "@/lib/oauth/oidc-provider-config"
import { createLogger, generateRequestId } from "@/lib/logger"

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
    const oidcPath = url.pathname.replace(/^\/api\/oauth/, "") || "/"

    // Build a minimal Node.js IncomingMessage
    const socket = new Socket()
    const nodeReq = new IncomingMessage(socket)
    nodeReq.method = request.method
    nodeReq.url = oidcPath + url.search

    // Copy headers
    for (const [key, value] of request.headers.entries()) {
      nodeReq.headers[key.toLowerCase()] = value
    }

    // For POST requests, we need to push the body into the request stream
    if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
      const bodyText = await request.text()
      nodeReq.push(bodyText)
      nodeReq.push(null) // Signal end of stream
    } else {
      nodeReq.push(null) // No body
    }

    // Build a ServerResponse that captures the output
    const nodeRes = new ServerResponse(nodeReq)

    return new Promise<Response>((resolve) => {
      const chunks: Buffer[] = []
      let statusCode = 200
      const responseHeaders: Record<string, string> = {}

      // Override writeHead to capture status and headers
      const originalWriteHead = nodeRes.writeHead.bind(nodeRes)
      nodeRes.writeHead = function (
        status: number,
        ...args: unknown[]
      ): ServerResponse<IncomingMessage> {
        statusCode = status

        // Headers can be in different positions depending on overload
        const hdrs = (typeof args[0] === "object" && args[0] !== null && !Array.isArray(args[0]))
          ? args[0] as Record<string, string | string[]>
          : (typeof args[1] === "object" && args[1] !== null && !Array.isArray(args[1]))
            ? args[1] as Record<string, string | string[]>
            : {}

        for (const [k, v] of Object.entries(hdrs)) {
          responseHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v)
        }

        return originalWriteHead(status, ...args as [string])
      }

      // Override write to capture body chunks
      nodeRes.write = function (chunk: unknown): boolean {
        if (Buffer.isBuffer(chunk)) chunks.push(chunk)
        else if (typeof chunk === "string") chunks.push(Buffer.from(chunk))
        return true
      } as typeof nodeRes.write

      // Override end to resolve the promise
      nodeRes.end = function (chunk?: unknown): ServerResponse<IncomingMessage> {
        if (chunk) {
          if (Buffer.isBuffer(chunk)) chunks.push(chunk)
          else if (typeof chunk === "string") chunks.push(Buffer.from(chunk))
        }

        // Also capture headers set via setHeader()
        const headerNames = nodeRes.getHeaderNames()
        for (const name of headerNames) {
          const val = nodeRes.getHeader(name)
          if (val !== undefined) {
            responseHeaders[name.toLowerCase()] = Array.isArray(val) ? val.join(", ") : String(val)
          }
        }

        statusCode = statusCode || nodeRes.statusCode

        const body = Buffer.concat(chunks)
        resolve(
          new Response(body.length > 0 ? body : null, {
            status: statusCode,
            headers: responseHeaders,
          })
        )

        // Cleanup
        socket.destroy()

        return nodeRes
      } as typeof nodeRes.end

      callback(nodeReq, nodeRes)
    })
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
