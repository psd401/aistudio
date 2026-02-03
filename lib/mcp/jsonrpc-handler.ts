/**
 * JSON-RPC 2.0 Protocol Handler for MCP
 * Dispatches MCP protocol methods: initialize, tools/list, tools/call.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolCallParams,
  McpToolContext,
  McpInitializeParams,
} from "./types"
import {
  JSONRPC_ERRORS,
  MCP_PROTOCOL_VERSION,
} from "./types"
import { getToolsForScopes, hasToolScope } from "./tool-registry"
import { TOOL_HANDLERS } from "./tool-handlers"
import { createLogger } from "@/lib/logger"

// ============================================
// Request Validation
// ============================================

export function parseJsonRpcRequest(body: unknown): JsonRpcRequest | null {
  if (!body || typeof body !== "object") return null
  const obj = body as Record<string, unknown>
  if (obj.jsonrpc !== "2.0" || typeof obj.method !== "string") return null

  return {
    jsonrpc: "2.0",
    method: obj.method as string,
    params: (obj.params as Record<string, unknown>) ?? undefined,
    id: (obj.id as string | number | null) ?? null,
  }
}

// ============================================
// Response Builders
// ============================================

function successResponse(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result }
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined && { data }) },
  }
}

// ============================================
// Method Dispatch
// ============================================

export async function handleJsonRpcRequest(
  rpcRequest: JsonRpcRequest,
  context: McpToolContext
): Promise<JsonRpcResponse> {
  const log = createLogger({ requestId: context.requestId, action: "jsonrpc" })

  // Notifications (id === undefined/null AND method does not expect response)
  // For MCP, we handle notifications like "notifications/initialized" silently
  if (rpcRequest.method.startsWith("notifications/")) {
    // Notifications have no response per JSON-RPC 2.0 spec.
    // Return an empty success for the HTTP layer to handle.
    return successResponse(rpcRequest.id, {})
  }

  switch (rpcRequest.method) {
    case "initialize":
      return handleInitialize(rpcRequest)

    case "tools/list":
      return handleToolsList(rpcRequest, context)

    case "tools/call":
      return handleToolsCall(rpcRequest, context, log)

    case "ping":
      return successResponse(rpcRequest.id, {})

    default:
      log.warn("Unknown MCP method", { method: rpcRequest.method })
      return errorResponse(
        rpcRequest.id,
        JSONRPC_ERRORS.METHOD_NOT_FOUND.code,
        `Method not found: ${rpcRequest.method}`
      )
  }
}

// ============================================
// initialize
// ============================================

function handleInitialize(rpcRequest: JsonRpcRequest): JsonRpcResponse {
  const params = rpcRequest.params as unknown as McpInitializeParams | undefined

  // Validate protocol version — accept our version
  const clientVersion = params?.protocolVersion
  if (clientVersion && clientVersion !== MCP_PROTOCOL_VERSION) {
    // Per MCP spec, server should respond with its own version
    // Client can decide if it's compatible
  }

  return successResponse(rpcRequest.id, {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: "aistudio-mcp",
      version: "1.0.0",
    },
  })
}

// ============================================
// tools/list
// ============================================

function handleToolsList(
  rpcRequest: JsonRpcRequest,
  context: McpToolContext
): JsonRpcResponse {
  const tools = getToolsForScopes(context.scopes)

  return successResponse(rpcRequest.id, {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  })
}

// ============================================
// tools/call
// ============================================

async function handleToolsCall(
  rpcRequest: JsonRpcRequest,
  context: McpToolContext,
  log: ReturnType<typeof createLogger>
): Promise<JsonRpcResponse> {
  const params = rpcRequest.params as unknown as McpToolCallParams | undefined

  if (!params?.name) {
    return errorResponse(
      rpcRequest.id,
      JSONRPC_ERRORS.INVALID_PARAMS.code,
      "Missing required param: name"
    )
  }

  // Scope check
  if (!hasToolScope(context.scopes, params.name)) {
    log.warn("MCP tool scope denied", {
      tool: params.name,
      userId: context.userId,
    })
    return errorResponse(
      rpcRequest.id,
      JSONRPC_ERRORS.INVALID_PARAMS.code,
      `Insufficient scope for tool: ${params.name}`
    )
  }

  // Find handler
  const handler = TOOL_HANDLERS[params.name]
  if (!handler) {
    return errorResponse(
      rpcRequest.id,
      JSONRPC_ERRORS.METHOD_NOT_FOUND.code,
      `Unknown tool: ${params.name}`
    )
  }

  try {
    const result = await handler(params.arguments ?? {}, context)
    return successResponse(rpcRequest.id, result)
  } catch (error) {
    log.error("MCP tool execution error", {
      tool: params.name,
      error: error instanceof Error ? error.message : String(error),
    })
    return errorResponse(
      rpcRequest.id,
      JSONRPC_ERRORS.INTERNAL_ERROR.code,
      "Tool execution failed",
      { tool: params.name }
    )
  }
}
