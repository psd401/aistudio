/**
 * JSONB Type Definitions
 *
 * Type-safe interfaces for PostgreSQL JSONB columns.
 * Used with Drizzle's .$type<T>() for compile-time type safety.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #530 - Type unification strategy
 *
 * @example
 * ```typescript
 * import { jsonb } from 'drizzle-orm/pg-core';
 * import type { NexusCapabilities } from '@/lib/db/types/jsonb';
 *
 * export const aiModels = pgTable('ai_models', {
 *   nexusCapabilities: jsonb('nexus_capabilities').$type<NexusCapabilities>(),
 * });
 * ```
 */

// ============================================
// AI Models JSONB Types
// ============================================

/**
 * Nexus AI model capabilities flags
 */
export interface NexusCapabilities {
  canvas: boolean;
  thinking: boolean;
  artifacts: boolean;
  grounding: boolean;
  reasoning: boolean;
  webSearch: boolean;
  computerUse: boolean;
  responsesAPI: boolean;
  codeExecution: boolean;
  promptCaching: boolean;
  contextCaching: boolean;
  workspaceTools: boolean;
  codeInterpreter: boolean;
  /** Allow string indexing for dynamic access */
  [key: string]: boolean;
}

/**
 * AI provider-specific metadata
 */
export interface ProviderMetadata {
  max_context_length?: number;
  supports_streaming?: boolean;
  supports_function_calling?: boolean;
  [key: string]: unknown;
}

// ============================================
// Tool Input Field JSONB Types
// ============================================

/**
 * Options for tool input field customization
 */
export interface ToolInputFieldOptions {
  values?: string[];
  multiSelect?: boolean;
  placeholder?: string;
  [key: string]: unknown;
}

// ============================================
// Nexus Conversation JSONB Types
// ============================================

/**
 * Metadata for Nexus conversations
 */
export interface NexusConversationMetadata {
  tags?: string[];
  customFields?: Record<string, unknown>;
  providerData?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Settings for Nexus folders
 */
export interface NexusFolderSettings {
  sortBy?: "name" | "updated" | "created";
  viewMode?: "list" | "grid";
  autoArchive?: boolean;
  [key: string]: unknown;
}

/**
 * User settings for Nexus
 */
export interface NexusUserSettings {
  theme?: "light" | "dark" | "system";
  notifications?: boolean;
  shortcuts?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Event data for conversation history
 */
export interface NexusConversationEventData {
  eventType:
    | "created"
    | "updated"
    | "archived"
    | "shared"
    | "moved"
    | "deleted";
  userId: number;
  changes?: Record<string, unknown>;
  timestamp: string;
  [key: string]: unknown;
}

// ============================================
// MCP (Model Context Protocol) JSONB Types
// ============================================

/**
 * JSON Schema for MCP capabilities
 */
export interface NexusMcpSchema {
  type: "object" | "array" | "string" | "number" | "boolean";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * Audit data for MCP operations
 */
export interface NexusMcpAuditData {
  requestId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

// ============================================
// Template JSONB Types
// ============================================

/**
 * Variable definition for Nexus templates
 */
export interface NexusTemplateVariable {
  name: string;
  type: "string" | "number" | "boolean" | "array";
  description?: string;
  required?: boolean;
  default?: unknown;
}

// ============================================
// Schedule Management JSONB Types
// ============================================

/**
 * Configuration for scheduled executions
 */
export interface ScheduleConfig {
  frequency: "daily" | "weekly" | "monthly" | "custom";
  time?: string;
  timezone?: string;
  cron?: string;
  [key: string]: unknown;
}
