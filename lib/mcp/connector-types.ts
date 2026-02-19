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

/** Transport protocols supported for MCP server connections */
export type McpTransportType = "http" | "sse"

/** Authentication types for MCP server connections */
export type McpAuthType = "bearer" | "oauth2" | "api_key" | "none"

/** A registered MCP server with access control metadata */
export interface McpConnector {
  id: string
  name: string
  url: string
  transport: McpTransportType
  authType: McpAuthType
  /** If non-empty, only these user IDs may use this connector */
  allowedUsers: number[]
  maxConnections: number
}

// ─── Connection Status ───────────────────────────────────────────────────────

export type McpConnectionStatus = "connected" | "token_expired" | "reconnect_required" | "no_token"

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
}
