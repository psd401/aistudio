/**
 * MCP Protocol Types
 * JSON-RPC 2.0 and Model Context Protocol type definitions.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

// ============================================
// JSON-RPC 2.0 Types
// ============================================

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
  id: string | number | null
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

// JSON-RPC 2.0 standard error codes
export const JSONRPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: "Parse error" },
  INVALID_REQUEST: { code: -32600, message: "Invalid Request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS: { code: -32602, message: "Invalid params" },
  INTERNAL_ERROR: { code: -32603, message: "Internal error" },
} as const

// ============================================
// MCP Protocol Types
// ============================================

export const MCP_PROTOCOL_VERSION = "2024-11-05"

export interface McpServerInfo {
  name: string
  version: string
}

export interface McpCapabilities {
  tools?: { listChanged?: boolean }
}

export interface McpInitializeParams {
  protocolVersion: string
  capabilities: Record<string, unknown>
  clientInfo: {
    name: string
    version: string
  }
}

export interface McpInitializeResult {
  protocolVersion: string
  capabilities: McpCapabilities
  serverInfo: McpServerInfo
}

// ============================================
// MCP Tool Types
// ============================================

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, McpToolProperty>
    required?: string[]
  }
}

export interface McpToolProperty {
  type: string
  description: string
  enum?: string[]
  items?: { type: string }
  default?: unknown
}

export interface McpToolCallParams {
  name: string
  arguments?: Record<string, unknown>
}

export interface McpToolResult {
  content: McpContentItem[]
  isError?: boolean
}

export interface McpContentItem {
  type: "text" | "image" | "resource"
  text?: string
  mimeType?: string
  data?: string
}

// ============================================
// MCP Tool Handler Type
// ============================================

export type McpToolHandler = (
  args: Record<string, unknown>,
  context: McpToolContext
) => Promise<McpToolResult>

export interface McpToolContext {
  userId: number
  cognitoSub: string
  scopes: string[]
  requestId: string
}
