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
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"
import { compareVersionsDesc } from "@/lib/tools/catalog/utils"
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
      return await handleToolsList(rpcRequest, context, log)

    case "tools/call":
      return await handleToolsCall(rpcRequest, context, log)

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

async function handleToolsList(
  rpcRequest: JsonRpcRequest,
  context: McpToolContext,
  log: ReturnType<typeof createLogger>
): Promise<JsonRpcResponse> {
  // Versioning (#927): by DEFAULT, return only the latest non-deprecated version
  // of each tool. The opt-in `include: "all"` param returns every version
  // including deprecated ones, each tagged with a `deprecated` boolean so a
  // client can distinguish them. `include` arrives either as a JSON-RPC param
  // (`params.include`) or, for convenience, the `?include=all` query string the
  // route merges into params.
  const includeAll =
    (rpcRequest.params as { include?: unknown } | undefined)?.include === "all"

  // Catalog-backed: list active tools exposed on the `mcp` surface and filtered
  // by the caller's scopes. The catalog merges code-manifest tools (the 5
  // migrated MCP tools) with any assistant/skill-derived MCP tools. Deprecated
  // tools are excluded unless `include: "all"`.
  const tools = await toolCatalogInstance.list({
    surface: "mcp",
    scopes: context.scopes,
    excludeDeprecated: !includeAll,
  })

  // Default view: collapse to the latest version per identifier so a client sees
  // exactly one entry per logical tool. With `include: "all"` we keep every
  // version (the client opted into the full set). `selectListedTools` is pure +
  // unit-tested.
  const listed = selectListedTools(tools, includeAll)

  log.debug("tools/list resolved from catalog", {
    count: listed.length,
    includeAll,
  })

  return successResponse(rpcRequest.id, {
    tools: listed.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      // Version metadata so clients can pin / detect deprecation. `deprecated`
      // is only ever true in the include=all view (default hides deprecated).
      version: t.version,
      identifier: t.identifier,
      ...(t.deprecatedAt
        ? { deprecated: true, replacedBy: t.replacedBy ?? null }
        : {}),
    })),
  })
}

/**
 * Choose which catalog entries `tools/list` returns (#927).
 *
 * - `includeAll = false` (default): one entry per identifier — the highest
 *   version present (already deprecation-filtered upstream).
 * - `includeAll = true`: every entry as-is (all versions, incl. deprecated).
 *
 * Pure so the collapse-to-latest logic is unit-testable without the catalog/DB.
 * Exported for tests.
 */
export function selectListedTools<
  T extends { identifier: string; version: string }
>(tools: readonly T[], includeAll: boolean): T[] {
  if (includeAll) return [...tools]
  const latestByIdentifier = new Map<string, T>()
  for (const tool of tools) {
    const current = latestByIdentifier.get(tool.identifier)
    if (!current || compareVersionsDesc(tool.version, current.version) < 0) {
      latestByIdentifier.set(tool.identifier, tool)
    }
  }
  return [...latestByIdentifier.values()]
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

  try {
    // Catalog dispatch owns the full flow: it resolves the MCP-surfaced tool,
    // checks scope, and invokes the code handler, returning a typed discriminant
    // so we map each failure to the correct JSON-RPC error code without sniffing
    // message text.
    const dispatchResult = await toolCatalogInstance.dispatch(
      params.name,
      params.arguments ?? {},
      context
    )

    if (!dispatchResult.ok) {
      switch (dispatchResult.reason) {
        case "scope_denied":
          log.warn("MCP tool scope denied", {
            tool: params.name,
            userId: context.userId,
          })
          return errorResponse(
            rpcRequest.id,
            JSONRPC_ERRORS.INVALID_PARAMS.code,
            `Insufficient scope for tool: ${params.name}`
          )
        case "no_handler":
          log.warn("MCP tool has no dispatchable handler", { tool: params.name })
          return errorResponse(
            rpcRequest.id,
            JSONRPC_ERRORS.METHOD_NOT_FOUND.code,
            `Tool not dispatchable: ${params.name}`
          )
        case "unknown":
        default:
          return errorResponse(
            rpcRequest.id,
            JSONRPC_ERRORS.METHOD_NOT_FOUND.code,
            `Unknown tool: ${params.name}`
          )
      }
    }

    return successResponse(rpcRequest.id, dispatchResult.result)
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
