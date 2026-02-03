/**
 * MCP Server Barrel Exports
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

export { parseJsonRpcRequest, handleJsonRpcRequest } from "./jsonrpc-handler"
export { getToolsForScopes, hasToolScope, TOOL_SCOPE_MAP, MCP_TOOLS } from "./tool-registry"
export { TOOL_HANDLERS } from "./tool-handlers"
export { createSession, getSession, removeSession, getSessionCount } from "./session-manager"
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDefinition,
  McpToolResult,
  McpToolContext,
  McpToolHandler,
} from "./types"
export { JSONRPC_ERRORS, MCP_PROTOCOL_VERSION } from "./types"
