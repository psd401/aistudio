/**
 * Type definitions for MCP Connector Service
 *
 * Covers external MCP server integration: connector metadata, tool fetching,
 * token management, and audit logging.
 *
 * Part of Epic #774 — Nexus MCP Connectors
 * Issue #778
 */

import type { MCPClient } from "@ai-sdk/mcp"

/** The tool set returned by MCPClient.tools() */
export type McpToolSet = Awaited<ReturnType<MCPClient["tools"]>>

// ─── Connector Metadata ──────────────────────────────────────────────────────

/**
 * Transport protocols stored in the DB (CHECK constraint in 028-nexus-schema.sql).
 * Only "http" is supported at runtime by @ai-sdk/mcp for server-to-server
 * connections. "stdio" and "websocket" are rejected by assertHttpTransport().
 */
export type McpTransportType = "stdio" | "http" | "websocket"

/**
 * Authentication types for MCP server connections.
 * Must match CHECK constraint in 028-nexus-schema.sql.
 */
export type McpAuthType = "api_key" | "oauth" | "jwt" | "none" | "cognito_passthrough"

/** A registered MCP server with access control metadata */
export interface McpConnector {
  id: string
  name: string
  url: string
  transport: McpTransportType
  authType: McpAuthType
  /** If non-empty, only these user IDs may use this connector */
  allowedUsers: number[]
}

// ─── Connection Status ───────────────────────────────────────────────────────

export type McpConnectionStatus = "connected" | "token_expired" | "no_token"

export interface McpUserConnectionStatus {
  serverId: string
  status: McpConnectionStatus
  tokenExpiresAt: Date | null
}

// ─── Token Refresh ───────────────────────────────────────────────────────────

export interface McpTokenRefreshResult {
  success: boolean
  /** When true, the user must re-authenticate via OAuth flow */
  reconnectRequired?: boolean
  tokenExpiresAt?: Date
}

// ─── Tool Fetching ───────────────────────────────────────────────────────────

export interface McpConnectorToolsResult {
  serverId: string
  serverName: string
  tools: McpToolSet
  /** Call this when the chat request finishes (onFinish/onError) */
  close: () => Promise<void>
}

// ─── Audit Logging ───────────────────────────────────────────────────────────

export interface McpToolCallLogEntry {
  userId: number
  serverId: string
  toolName: string
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  durationMs: number
  error?: string
  /** Client IP address (forwarded from request headers) */
  ipAddress?: string
  /** Client user-agent string */
  userAgent?: string
}
