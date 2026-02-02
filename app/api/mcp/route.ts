/**
 * MCP Streamable HTTP Endpoint
 * POST /api/mcp — JSON-RPC 2.0 requests over HTTP
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 *
 * Transport: Streamable HTTP (current MCP spec, not deprecated HTTP+SSE)
 * Auth: Bearer token (API key sk-... or JWT)
 * Response: application/json for single results, text/event-stream for streaming
 */

import { NextRequest, NextResponse } from "next/server"
import { authenticateRequest } from "@/lib/api/auth-middleware"
import { checkRateLimit, createRateLimitResponse, addRateLimitHeaders, recordUsage } from "@/lib/api/rate-limiter"
import { parseJsonRpcRequest, handleJsonRpcRequest } from "@/lib/mcp/jsonrpc-handler"
import { JSONRPC_ERRORS } from "@/lib/mcp/types"
import type { McpToolContext, JsonRpcResponse } from "@/lib/mcp/types"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"

export const maxDuration = 900

// ============================================
// POST /api/mcp
// ============================================

export async function POST(request: NextRequest): Promise<NextResponse | Response> {
  const requestId = generateRequestId()
  const timer = startTimer("mcp.request")
  const log = createLogger({ requestId, action: "mcp.route" })
  const startMs = Date.now()

  // --- Auth ---
  const authResult = await authenticateRequest(request)
  if (!("userId" in authResult)) {
    timer({ status: "auth_failed" })
    return authResult
  }
  const auth = authResult

  // --- Rate limit ---
  const rateLimitResult = await checkRateLimit(auth)
  if (!rateLimitResult.allowed) {
    timer({ status: "rate_limited" })
    recordUsage(auth, request, 429, Date.now() - startMs)
    return createRateLimitResponse(requestId, rateLimitResult)
  }

  // --- Parse body ---
  let body: unknown
  try {
    body = await request.json()
  } catch {
    timer({ status: "parse_error" })
    recordUsage(auth, request, 400, Date.now() - startMs)
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: JSONRPC_ERRORS.PARSE_ERROR,
      },
      {
        status: 400,
        headers: { "X-Request-Id": requestId },
      }
    )
  }

  // --- Validate JSON-RPC ---
  const rpcRequest = parseJsonRpcRequest(body)
  if (!rpcRequest) {
    timer({ status: "invalid_request" })
    recordUsage(auth, request, 400, Date.now() - startMs)
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: JSONRPC_ERRORS.INVALID_REQUEST,
      },
      {
        status: 400,
        headers: { "X-Request-Id": requestId },
      }
    )
  }

  log.info("MCP request", {
    method: rpcRequest.method,
    userId: auth.userId,
    authType: auth.authType,
  })

  // --- Build context ---
  const context: McpToolContext = {
    userId: auth.userId,
    cognitoSub: auth.cognitoSub,
    scopes: auth.scopes,
    requestId,
  }

  // --- Dispatch ---
  try {
    const rpcResponse = await handleJsonRpcRequest(rpcRequest, context)

    const statusCode = rpcResponse.error ? mapRpcErrorToHttp(rpcResponse.error.code) : 200

    const response = NextResponse.json(rpcResponse, {
      status: statusCode,
      headers: {
        "X-Request-Id": requestId,
      },
    })
    addRateLimitHeaders(response, rateLimitResult)

    timer({ status: "success" })
    recordUsage(auth, request, statusCode, Date.now() - startMs)

    return response
  } catch (error) {
    log.error("MCP handler error", {
      method: rpcRequest.method,
      error: error instanceof Error ? error.message : String(error),
    })

    timer({ status: "error" })
    recordUsage(auth, request, 500, Date.now() - startMs)

    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: rpcRequest.id,
        error: {
          code: JSONRPC_ERRORS.INTERNAL_ERROR.code,
          message: "Internal server error",
        },
      } satisfies JsonRpcResponse,
      {
        status: 500,
        headers: { "X-Request-Id": requestId },
      }
    )
  }
}

// ============================================
// Helpers
// ============================================

function mapRpcErrorToHttp(rpcCode: number): number {
  switch (rpcCode) {
    case JSONRPC_ERRORS.PARSE_ERROR.code:
      return 400
    case JSONRPC_ERRORS.INVALID_REQUEST.code:
      return 400
    case JSONRPC_ERRORS.METHOD_NOT_FOUND.code:
      return 404
    case JSONRPC_ERRORS.INVALID_PARAMS.code:
      return 400
    case JSONRPC_ERRORS.INTERNAL_ERROR.code:
      return 500
    default:
      return 500
  }
}
