/**
 * Server-Sent Events (SSE) type definitions for Assistant Architect streaming API
 *
 * This module defines all custom SSE event types used during assistant architect execution.
 * Events provide fine-grained progress tracking for:
 * - Execution lifecycle (start, complete, error)
 * - Prompt-level progress (start, complete)
 * - Variable substitution
 * - Knowledge retrieval
 * - Tool execution
 * - Overall progress tracking
 *
 * @module types/sse-events
 */

/**
 * Base interface for all SSE events
 */
export interface BaseSSEEvent {
  /** ISO 8601 timestamp of when the event was generated */
  timestamp: string;
  /** Optional event ID for client-side tracking and retry */
  eventId?: string;
}

/**
 * Execution lifecycle events
 */

/** Emitted when assistant architect execution starts */
export interface ExecutionStartEvent extends BaseSSEEvent {
  executionId: number;
  totalPrompts: number;
  toolName: string;
}

/** Emitted when execution completes successfully */
export interface ExecutionCompleteEvent extends BaseSSEEvent {
  executionId: number;
  totalTokens: number;
  duration: number;
  success: true;
  /**
   * Estimated spend for an agentic run in whole cents, computed from token
   * usage × the model's per-token rates (Issue #926 — epic #922 audit).
   * `null` when the model has no complete pricing or usage was unreported;
   * absent for prompt-chain executions.
   */
  estimatedCostCents?: number | null;
}

/** Emitted when execution fails */
export interface ExecutionErrorEvent extends BaseSSEEvent {
  executionId: number;
  error: string;
  promptId?: number;
  recoverable: boolean;
  details?: string;
}

/**
 * Prompt-level events
 */

/** Emitted when a prompt starts executing */
export interface PromptStartEvent extends BaseSSEEvent {
  promptId: number;
  promptName: string;
  position: number;
  totalPrompts: number;
  modelId: string;
  hasKnowledge: boolean;
  hasTools: boolean;
}

/** Emitted when a prompt completes */
export interface PromptCompleteEvent extends BaseSSEEvent {
  promptId: number;
  outputTokens: number;
  duration: number;
  cached: boolean;
}

/**
 * Variable and context events
 */

/** Emitted when variables are substituted in a prompt */
export interface VariableSubstitutionEvent extends BaseSSEEvent {
  promptId: number;
  variables: Record<string, string>;
  sourcePrompts: number[];
}

/** Emitted when knowledge retrieval starts */
export interface KnowledgeRetrievalStartEvent extends BaseSSEEvent {
  promptId: number;
  repositories: number[];
  searchType: 'vector' | 'keyword' | 'hybrid';
}

/** Emitted when knowledge has been retrieved */
export interface KnowledgeRetrievedEvent extends BaseSSEEvent {
  promptId: number;
  documentsFound: number;
  relevanceScore: number;
  tokens: number;
}

/**
 * Tool execution events
 */

/** Emitted when a tool starts executing */
export interface ToolExecutionStartEvent extends BaseSSEEvent {
  promptId: number;
  toolName: string;
  parameters?: Record<string, unknown>;
}

/** Emitted when a tool completes execution */
export interface ToolExecutionCompleteEvent extends BaseSSEEvent {
  promptId: number;
  toolName: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Progress tracking
 */

/** Emitted periodically to show overall progress */
export interface ProgressEvent extends BaseSSEEvent {
  currentStep: number;
  totalSteps: number;
  percentage: number;
  message: string;
}

/**
 * Union type of all possible SSE event data
 */
export type SSEEventData =
  | ExecutionStartEvent
  | ExecutionCompleteEvent
  | ExecutionErrorEvent
  | PromptStartEvent
  | PromptCompleteEvent
  | VariableSubstitutionEvent
  | KnowledgeRetrievalStartEvent
  | KnowledgeRetrievedEvent
  | ToolExecutionStartEvent
  | ToolExecutionCompleteEvent
  | ProgressEvent;

/**
 * SSE event type names
 */
export type SSEEventType =
  | 'execution-start'
  | 'execution-complete'
  | 'execution-error'
  | 'prompt-start'
  | 'prompt-complete'
  | 'variable-substitution'
  | 'knowledge-retrieval-start'
  | 'knowledge-retrieved'
  | 'tool-execution-start'
  | 'tool-execution-complete'
  | 'progress';

/**
 * Complete SSE event with type and data
 */
export interface SSEEvent<T extends SSEEventData = SSEEventData> {
  /** The event type name (e.g., 'prompt-start') */
  event: SSEEventType;
  /** The event data payload */
  data: T;
}

/**
 * Mapping of event types to their data types
 */
export interface SSEEventMap {
  'execution-start': ExecutionStartEvent;
  'execution-complete': ExecutionCompleteEvent;
  'execution-error': ExecutionErrorEvent;
  'prompt-start': PromptStartEvent;
  'prompt-complete': PromptCompleteEvent;
  'variable-substitution': VariableSubstitutionEvent;
  'knowledge-retrieval-start': KnowledgeRetrievalStartEvent;
  'knowledge-retrieved': KnowledgeRetrievedEvent;
  'tool-execution-start': ToolExecutionStartEvent;
  'tool-execution-complete': ToolExecutionCompleteEvent;
  'progress': ProgressEvent;
}

/**
 * Type-safe event emitter function signature
 */
export type SSEEventEmitter = <K extends SSEEventType>(
  eventType: K,
  data: Omit<SSEEventMap[K], 'timestamp' | 'eventId'>
) => void;

/**
 * Client-side event handler function signature
 */
export type SSEEventHandler<K extends SSEEventType> = (
  event: SSEEventMap[K]
) => void;

/**
 * Client-side event listener map
 */
export type SSEEventListeners = {
  [K in SSEEventType]?: SSEEventHandler<K>;
};
