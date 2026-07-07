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
import {
  pickLatestNonDeprecated,
  type VersionedEntry,
} from "@/lib/tools/catalog/version-resolver"
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
  // migrated MCP tools) with any assistant/skill-derived MCP tools.
  //
  // We intentionally DO NOT pass `excludeDeprecated` here, even for the default
  // view: `selectListedTools` applies the same per-identifier policy `resolve()`
  // uses (latest non-deprecated, falling back to the latest deprecated only when
  // EVERY version is deprecated). Pre-filtering deprecated rows away would hide
  // an all-deprecated tool from `tools/list` entirely while `tools/call`/
  // `resolve()` would still happily dispatch its latest deprecated version — a
  // silent list-vs-call divergence (#1044 review). Listing the full set and
  // collapsing with the shared helper keeps the two paths in agreement.
  const tools = await toolCatalogInstance.list({
    surface: "mcp",
    scopes: context.scopes,
  })

  // Default view: collapse to one entry per identifier via the shared
  // `pickLatestNonDeprecated` policy. With `include: "all"` we keep every version
  // (the client opted into the full set). `selectListedTools` is pure +
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
      // Version metadata so clients can pin / detect deprecation. In the default
      // view `deprecated` is normally absent (the latest non-deprecated version
      // is chosen); it appears with `include: "all"`, OR when every version of a
      // tool is deprecated and the latest deprecated one is surfaced as the
      // fallback (so an all-deprecated-but-callable tool is still flagged).
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
 * - `includeAll = false` (default): one entry per identifier, chosen by the SAME
 *   policy `resolve()` uses for an unpinned reference — the latest non-deprecated
 *   version, falling back to the latest deprecated version only when EVERY
 *   version of that identifier is deprecated. Sharing `pickLatestNonDeprecated`
 *   guarantees `tools/list` and `tools/call`/`resolve()` never disagree on an
 *   all-deprecated tool (which would otherwise be invisible here yet invocable).
 *   The input is expected to be the FULL version set (not deprecation-filtered),
 *   so this can apply the fallback itself.
 * - `includeAll = true`: every entry as-is (all versions, incl. deprecated).
 *
 * Pure so the collapse logic is unit-testable without the catalog/DB. Exported
 * for tests.
 */
export function selectListedTools<T extends VersionedEntry>(
  tools: readonly T[],
  includeAll: boolean
): T[] {
  if (includeAll) return [...tools]
  const byIdentifier = new Map<string, T[]>()
  for (const tool of tools) {
    const group = byIdentifier.get(tool.identifier)
    if (group) group.push(tool)
    else byIdentifier.set(tool.identifier, [tool])
  }
  const selected: T[] = []
  for (const group of byIdentifier.values()) {
    const pick = pickLatestNonDeprecated(group)
    if (pick) selected.push(pick)
  }
  return selected
}

// ============================================
// tools/call
// ============================================

/**
 * Rebuilds a user-supplied JSON-RPC `arguments` object with a NULL prototype and
 * without the prototype-pollution keys (`__proto__` / `constructor` / `prototype`),
 * so a crafted `tools/call` payload cannot smuggle those own-keys into any
 * downstream code that spreads, `Object.assign`es, or `for..in`-copies the
 * arguments into another object (REV-SEC-190). Defense-in-depth for future tool
 * handlers — current handlers read specific keys by direct access and are not
 * vulnerable on their own. Non-object input (absent/primitive/array) collapses to
 * an empty null-proto object, preserving the previous `?? {}` default; a shallow
 * scrub is sufficient because handlers read their own top-level keys.
 */
function sanitizeToolArguments(args: unknown): Record<string, unknown> {
  const safe: Record<string, unknown> = Object.create(null)
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const entries = Object.entries(args as Record<string, unknown>).filter(
      ([key]) => key !== "__proto__" && key !== "constructor" && key !== "prototype"
    )
    Object.assign(safe, Object.fromEntries(entries))
  }
  return safe
}

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
      sanitizeToolArguments(params.arguments),
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
