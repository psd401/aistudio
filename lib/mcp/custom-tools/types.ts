/**
 * Shared types for custom tool providers.
 *
 * Custom tool providers supply built-in tool definitions for services
 * that don't support MCP server-to-server connections (e.g., Canva Connect API).
 */

import type { ToolSet } from "ai"

export interface CustomToolProvider {
  /** Unique provider key (e.g., "canva") */
  key: string
  /** URL patterns to match for auto-detection */
  urlPatterns: RegExp[]
  /** Build tools using the user's OAuth access token */
  buildTools(accessToken: string): ToolSet
}
