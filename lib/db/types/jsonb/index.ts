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
 * import type { ProviderMetadata } from '@/lib/db/types/jsonb';
 *
 * export const aiModels = pgTable('ai_models', {
 *   providerMetadata: jsonb('provider_metadata').$type<ProviderMetadata>(),
 * });
 * ```
 */

// ============================================
// AI Models JSONB Types
// ============================================

/**
 * Nexus AI model capabilities flags
 *
 * @deprecated Issue #594: This interface is deprecated. Use the unified
 * `capabilities` TEXT/JSON array field and @/lib/ai/capability-utils helpers
 * for capability checks instead. This interface is retained temporarily for
 * backward compatibility with admin UI components during the transition.
 *
 * @see @/lib/ai/capability-utils for the new capability handling pattern
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
  imageGeneration?: boolean;
  deepResearch?: boolean;
  /** Allow string indexing for dynamic access */
  [key: string]: boolean | undefined;
}

/**
 * AI provider-specific metadata
 *
 * Note: Uses snake_case to match external API responses (OpenAI, Anthropic, etc.)
 * These fields are stored as-is in JSONB columns.
 */
export interface ProviderMetadata {
  max_context_length?: number;
  supports_streaming?: boolean;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  /** Preferred shared automatic-routing tier. */
  modelRouterTier?: "light" | "medium" | "high";
  /** Legacy Nexus-specific routing tier retained for backward compatibility. */
  nexusRouterTier?: "light" | "medium" | "high";
  /** Allow additional provider-specific fields */
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
 * Metadata for Assistant Architect prompt execution messages
 * Stored in nexus_messages.metadata for assistant architect chain executions.
 * Part of PR #715 - Save prompt chain results as conversation messages
 */
export interface AssistantArchitectMessageMetadata extends NexusConversationMetadata {
  source: 'assistant-architect-execution';
  executionId: number;
  promptId: number;
  promptName: string;
  position: number;
  executionTimeMs?: number;
  modelRouting?: Record<string, unknown>;
  failed?: boolean;
  error?: string;
}

/**
 * Metadata for Decision Capture conversations (provider: "decision-capture")
 * Stored in nexus_conversations.metadata for decision capture sessions.
 * Part of Epic #675 (Context Graph Decision Capture Layer) - Issue #681
 */
export interface DecisionCaptureMetadata extends NexusConversationMetadata {
  captureType: "transcript" | "manual";
  committedNodeIds?: string[];
  committedEdgeIds?: string[];
}

/**
 * Metadata for Assistant Architect conversations (provider: "assistant-architect")
 * Stored in nexus_conversations.metadata for assistant architect executions.
 * Part of PR #717 - Conversation list provider filtering
 */
export interface AssistantArchitectConversationMetadata extends NexusConversationMetadata {
  /** ID of the assistant architect tool that created this conversation */
  assistantId?: number;
  /** Name of the assistant architect that created this conversation */
  assistantName?: string;
  /** Owner-resolved temporary repositories available to API follow-up turns. */
  runtimeRepositoryIds?: number[];
  /** Current execution status for display in conversation list */
  executionStatus?: 'running' | 'completed' | 'failed';
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
  /** Standard hides model/tool routing controls; Advanced exposes a family constraint. */
  nexusMode?: "standard" | "advanced";
  /** Optional provider-family constraint used only in Advanced mode. */
  preferredModelFamily?: "auto" | "openai" | "anthropic" | "google";
  [key: string]: unknown;
}

/**
 * Event data for conversation history
 *
 * Event types follow the pattern: "conversation_{action}"
 * This matches the event_type column in nexus_conversation_events table
 */
export interface NexusConversationEventData {
  eventType:
    | "conversation_created"
    | "conversation_updated"
    | "conversation_archived"
    | "conversation_unarchived"
    | "conversation_pinned"
    | "conversation_unpinned"
    | "conversation_shared"
    | "conversation_moved"
    | "conversation_deleted"
    | "conversation_forked"
    | "conversation_created_from_fork";
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
// User Profile JSONB Types
// ============================================

/**
 * Extensible user profile data stored as JSONB
 * Part of Epic #674 (External API Platform) - Issue #684
 */
export interface UserProfile {
  yearsInDistrict?: number;
  certificationAreas?: string[];
  areasOfExpertise?: string[];
  preferredName?: string;
  pronouns?: string;
  startDate?: string;
  previousRoles?: string[];
  [key: string]: unknown;
}

// ============================================
// Prompt Library JSONB Types
// ============================================

/**
 * Settings for prompt library entries
 * Stores model, tools, and connector configuration
 */
export interface PromptLibrarySettings {
  modelId?: string;
  tools?: string[];
  connectors?: string[];
}

// ============================================
// Context Graph JSONB Types
// ============================================

/**
 * PROV-O-idiom provenance recorded on agent-authored graph nodes/edges
 * (Issue #1252). Written by the shared decision-capture write path.
 */
export interface GraphProvenance {
  /**
   * Which channel produced this node/edge:
   * "api" (external REST key), "agent" (agentId-tagged capture), or
   * "decision-capture" (conversational commit).
   */
  extractionMethod: string;
  /** Reference to the originating actor/request (agentId when present, else the requestId). */
  sourceRef: string;
  /**
   * Confidence in the capture (0-1). Structured translation of caller-supplied
   * fields is deterministic, so this is 1 for structured captures; kept as a
   * field so LLM-scored captures can lower it later without a type change.
   */
  confidence: number;
}

/**
 * Non-destructive entity-resolution audit recorded on a captured node when it
 * was auto-reused (>= the auto-reuse similarity threshold) instead of created
 * (Issue #1252). Never triggers a destructive merge.
 */
export interface GraphDedupMetadata {
  /** The existing node that this mention was resolved to. */
  matchedNodeId: string;
  /** Cosine similarity (0-1) that drove the reuse. */
  similarity: number;
}

/** Persisted completeness snapshot stored on the primary decision node. */
export interface GraphCompletenessMetadata {
  score: number;
  method: "rule-based" | "llm-enhanced";
  warnings: string[];
}

/**
 * Metadata for graph nodes
 * Flexible structure for storing node-specific properties
 * Part of Context Graph Foundation epic (Issues #665, #666)
 */
export interface GraphNodeMetadata {
  /** Legacy provenance conventions (Issue #675). */
  source?: string;
  agentId?: string;
  /** Alternative decisions carry rejected: true (translator). */
  rejected?: boolean;
  /** Typed PROV-O provenance (Issue #1252). */
  provenance?: GraphProvenance;
  /** Entity-resolution reuse audit (Issue #1252). */
  dedup?: GraphDedupMetadata;
  /** Completeness snapshot (primary decision node only). */
  completeness?: GraphCompletenessMetadata;
  // Additional node-specific properties may be attached.
  [key: string]: unknown;
}

/**
 * Metadata for graph edges
 * Flexible structure for storing edge-specific properties
 * Part of Context Graph Foundation epic (Issues #665, #666)
 */
export interface GraphEdgeMetadata {
  /** Capture channel that created the edge. */
  source?: string;
  /** Typed PROV-O provenance (Issue #1252). */
  provenance?: GraphProvenance;
  // Additional edge-specific properties may be attached.
  [key: string]: unknown;
}
