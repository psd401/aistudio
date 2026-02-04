/**
 * TypeScript type definitions for Server-Sent Events (SSE) in AI streaming
 *
 * These types provide compile-time safety for SSE event handling to prevent
 * field name mismatches and improve developer experience across all streaming
 * implementations in the application.
 *
 * Compatible with Vercel AI SDK v5 and v6 stream protocols.
 * Verified: v6 maintains backward compatibility for all SSE event formats.
 *
 * @see https://sdk.vercel.ai/docs/ai-sdk-ui/stream-protocol
 * @see https://github.com/psd401/aistudio/issues/363
 * @see https://github.com/psd401/aistudio/issues/366
 */

/**
 * Base interface for all SSE events
 * Every event must have a type discriminator for runtime type checking
 */
export interface BaseSSEEvent {
  /** Event type discriminator - used for runtime type guards */
  type: string;
  /** Optional event ID for tracking lifecycle events */
  id?: string;
  /** Optional timestamp for debugging and monitoring */
  timestamp?: string;
}

// ============================================================================
// TEXT STREAMING EVENTS
// ============================================================================

/**
 * Text stream start event
 * Marks the beginning of a text content stream
 */
export interface TextStartEvent extends BaseSSEEvent {
  type: 'text-start';
  /** Unique identifier for this text stream */
  id: string;
}

/**
 * Text delta event - incremental text content
 *
 * CRITICAL: Uses `delta` field, NOT `textDelta`
 * This was the source of bug #367 where field name mismatch caused silent failures
 */
export interface TextDeltaEvent extends BaseSSEEvent {
  type: 'text-delta';
  /** Incremental text content to append */
  delta: string;
}

/**
 * Text stream end event
 * Marks completion of a text content stream
 */
export interface TextEndEvent extends BaseSSEEvent {
  type: 'text-end';
  /** ID of the text stream that completed */
  id: string;
}

// ============================================================================
// REASONING EVENTS (O1/O3 Models)
// ============================================================================

/**
 * Reasoning stream start event
 * Indicates the model has begun its reasoning/thinking phase
 */
export interface ReasoningStartEvent extends BaseSSEEvent {
  type: 'reasoning-start';
  /** Unique identifier for this reasoning stream */
  id: string;
}

/**
 * Reasoning delta event - incremental reasoning content
 * Used by advanced models like O1/O3 that expose their reasoning process
 */
export interface ReasoningDeltaEvent extends BaseSSEEvent {
  type: 'reasoning-delta';
  /** Incremental reasoning content */
  delta: string;
  /** Optional structured reasoning metadata */
  reasoning?: string;
}

/**
 * Reasoning stream end event
 * Marks completion of the reasoning phase
 */
export interface ReasoningEndEvent extends BaseSSEEvent {
  type: 'reasoning-end';
  /** ID of the reasoning stream that completed */
  id: string;
}

// ============================================================================
// TOOL EXECUTION EVENTS
// ============================================================================

/**
 * Tool call event - complete tool invocation information
 */
export interface ToolCallEvent extends BaseSSEEvent {
  type: 'tool-call';
  /** Unique identifier for this tool call */
  toolCallId: string;
  /** Name of the tool being invoked */
  toolName: string;
  /** Tool arguments (structured data) */
  args?: Record<string, unknown>;
}

/**
 * Tool call delta event - incremental tool call updates
 * Used for streaming tool argument construction
 */
export interface ToolCallDeltaEvent extends BaseSSEEvent {
  type: 'tool-call-delta';
  /** Unique identifier for this tool call */
  toolCallId: string;
  /** Name of the tool being invoked */
  toolName: string;
  /** Incremental argument data */
  delta?: string;
}

/**
 * Tool input start event
 * Indicates tool input processing has begun
 */
export interface ToolInputStartEvent extends BaseSSEEvent {
  type: 'tool-input-start';
  /** Unique identifier for this tool call */
  toolCallId: string;
  /** Name of the tool */
  toolName: string;
}

/**
 * Tool input error event
 * Indicates validation or parsing error in tool inputs
 */
export interface ToolInputErrorEvent extends BaseSSEEvent {
  type: 'tool-input-error';
  /** Unique identifier for this tool call */
  toolCallId: string;
  /** Name of the tool */
  toolName: string;
  /** Error message describing the input validation failure */
  error?: string;
}

/**
 * Tool output error event
 * Indicates the tool execution failed
 */
export interface ToolOutputErrorEvent extends BaseSSEEvent {
  type: 'tool-output-error';
  /** Unique identifier for this tool call */
  toolCallId: string;
  /** Error text from tool execution */
  errorText?: string;
}

/**
 * Tool output available event
 * Indicates tool execution completed successfully
 */
export interface ToolOutputAvailableEvent extends BaseSSEEvent {
  type: 'tool-output-available';
  /** Unique identifier for this tool call */
  toolCallId: string;
  /** Tool execution result data */
  output?: unknown;
}

// ============================================================================
// SOURCE EVENTS
// ============================================================================

/**
 * Source URL event - web search citation/grounding source
 * Emitted by providers like Gemini when web search grounding is enabled.
 * Contains a URL reference that should be rendered as a clickable source card.
 */
export interface SourceUrlEvent extends BaseSSEEvent {
  type: 'source-url';
  /** Unique identifier for this source */
  sourceId: string;
  /** The URL of the source */
  url: string;
  /** Optional title of the source page */
  title?: string;
}

// ============================================================================
// LIFECYCLE EVENTS
// ============================================================================

/**
 * Stream start event
 * Marks initialization of the entire streaming session
 */
export interface StartEvent extends BaseSSEEvent {
  type: 'start';
}

/**
 * Step start event
 * Used in multi-step executions (e.g., Assistant Architect with multiple prompts)
 */
export interface StartStepEvent extends BaseSSEEvent {
  type: 'start-step';
  /** Optional step identifier */
  stepId?: string;
  /** Optional step description */
  stepName?: string;
}

/**
 * Step finish event
 * Marks completion of a step in multi-step execution
 */
export interface FinishStepEvent extends BaseSSEEvent {
  type: 'finish-step';
  /** Optional step identifier */
  stepId?: string;
}

/**
 * Message part interface for structured message content
 */
export interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Complete message structure
 */
export interface CompleteMessage {
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
  id?: string;
}

/**
 * Stream finish event
 * Marks successful completion of the entire streaming session
 */
export interface FinishEvent extends BaseSSEEvent {
  type: 'finish';
  /** Complete message with all content parts */
  message?: CompleteMessage;
  /** Usage statistics if available */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

// ============================================================================
// MESSAGE EVENTS
// ============================================================================

/**
 * Generic message event
 * Contains a complete message with structured parts
 */
export interface MessageEvent extends BaseSSEEvent {
  type: 'message';
  /** Message parts (text, images, etc.) */
  parts?: MessagePart[];
  /** Message role */
  role?: 'user' | 'assistant' | 'system';
}

/**
 * Assistant message event
 * Specific format for assistant responses
 */
export interface AssistantMessageEvent extends BaseSSEEvent {
  type: 'assistant-message';
  /** Message parts (text, images, etc.) */
  parts?: MessagePart[];
  /** Assistant message role is always 'assistant' */
  role: 'assistant';
}

// ============================================================================
// ERROR EVENTS
// ============================================================================

/**
 * Error event
 * Indicates a streaming error occurred
 */
export interface ErrorEvent extends BaseSSEEvent {
  type: 'error';
  /** Error message describing what went wrong */
  error: string;
  /** Optional error code for categorization */
  code?: string;
  /** Optional stack trace for debugging */
  stack?: string;
}

// ============================================================================
// UNION TYPE & TYPE GUARDS
// ============================================================================

/**
 * Discriminated union of all possible SSE event types
 * This enables exhaustive type checking in switch statements
 */
export type SSEEvent =
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ReasoningStartEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | ToolCallEvent
  | ToolCallDeltaEvent
  | ToolInputStartEvent
  | ToolInputErrorEvent
  | ToolOutputErrorEvent
  | ToolOutputAvailableEvent
  | SourceUrlEvent
  | StartEvent
  | StartStepEvent
  | FinishStepEvent
  | FinishEvent
  | MessageEvent
  | AssistantMessageEvent
  | ErrorEvent;

/**
 * Type guard for text-delta events
 * Validates both type and required fields with strict runtime checks
 */
export function isTextDeltaEvent(event: SSEEvent): event is TextDeltaEvent {
  return event.type === 'text-delta' &&
         'delta' in event &&
         typeof event.delta === 'string';
}

/**
 * Type guard for text-start events
 * Validates both type and required fields with strict runtime checks
 */
export function isTextStartEvent(event: SSEEvent): event is TextStartEvent {
  return event.type === 'text-start' &&
         'id' in event &&
         typeof event.id === 'string';
}

/**
 * Type guard for text-end events
 * Validates both type and required fields with strict runtime checks
 */
export function isTextEndEvent(event: SSEEvent): event is TextEndEvent {
  return event.type === 'text-end' &&
         'id' in event &&
         typeof event.id === 'string';
}

/**
 * Type guard for reasoning-delta events
 * Validates both type and required fields with strict runtime checks
 */
export function isReasoningDeltaEvent(event: SSEEvent): event is ReasoningDeltaEvent {
  return event.type === 'reasoning-delta' &&
         'delta' in event &&
         typeof event.delta === 'string';
}

/**
 * Type guard for reasoning-start events
 * Validates both type and required fields with strict runtime checks
 */
export function isReasoningStartEvent(event: SSEEvent): event is ReasoningStartEvent {
  return event.type === 'reasoning-start' &&
         'id' in event &&
         typeof event.id === 'string';
}

/**
 * Type guard for reasoning-end events
 * Validates both type and required fields with strict runtime checks
 */
export function isReasoningEndEvent(event: SSEEvent): event is ReasoningEndEvent {
  return event.type === 'reasoning-end' &&
         'id' in event &&
         typeof event.id === 'string';
}

/**
 * Type guard for tool-call events
 * Validates both type and required fields with strict runtime checks
 */
export function isToolCallEvent(event: SSEEvent): event is ToolCallEvent {
  return event.type === 'tool-call' &&
         'toolCallId' in event &&
         typeof event.toolCallId === 'string' &&
         'toolName' in event &&
         typeof event.toolName === 'string';
}

/**
 * Type guard for tool-call-delta events
 * Validates both type and required fields with strict runtime checks
 */
export function isToolCallDeltaEvent(event: SSEEvent): event is ToolCallDeltaEvent {
  return event.type === 'tool-call-delta' &&
         'toolCallId' in event &&
         typeof event.toolCallId === 'string' &&
         'toolName' in event &&
         typeof event.toolName === 'string';
}

/**
 * Type guard for tool-input-start events
 * Validates both type and required fields with strict runtime checks
 */
export function isToolInputStartEvent(event: SSEEvent): event is ToolInputStartEvent {
  return event.type === 'tool-input-start' &&
         'toolCallId' in event &&
         typeof event.toolCallId === 'string' &&
         'toolName' in event &&
         typeof event.toolName === 'string';
}

/**
 * Type guard for tool-input-error events
 * Validates both type and required fields with strict runtime checks
 */
export function isToolInputErrorEvent(event: SSEEvent): event is ToolInputErrorEvent {
  return event.type === 'tool-input-error' &&
         'toolCallId' in event &&
         typeof event.toolCallId === 'string' &&
         'toolName' in event &&
         typeof event.toolName === 'string';
}

/**
 * Type guard for tool-output-error events
 * Validates both type and required fields with strict runtime checks
 */
export function isToolOutputErrorEvent(event: SSEEvent): event is ToolOutputErrorEvent {
  return event.type === 'tool-output-error' &&
         'toolCallId' in event &&
         typeof event.toolCallId === 'string';
}

/**
 * Type guard for tool-output-available events
 * Validates both type and required fields with strict runtime checks
 */
export function isToolOutputAvailableEvent(event: SSEEvent): event is ToolOutputAvailableEvent {
  return event.type === 'tool-output-available' &&
         'toolCallId' in event &&
         typeof event.toolCallId === 'string';
}

/**
 * Type guard for source-url events
 * Validates both type and required fields with strict runtime checks
 */
export function isSourceUrlEvent(event: SSEEvent): event is SourceUrlEvent {
  return event.type === 'source-url' &&
         'sourceId' in event &&
         typeof event.sourceId === 'string' &&
         'url' in event &&
         typeof event.url === 'string';
}

/**
 * Type guard for start events
 */
export function isStartEvent(event: SSEEvent): event is StartEvent {
  return event.type === 'start';
}

/**
 * Type guard for start-step events
 */
export function isStartStepEvent(event: SSEEvent): event is StartStepEvent {
  return event.type === 'start-step';
}

/**
 * Type guard for finish-step events
 */
export function isFinishStepEvent(event: SSEEvent): event is FinishStepEvent {
  return event.type === 'finish-step';
}

/**
 * Type guard for finish events
 */
export function isFinishEvent(event: SSEEvent): event is FinishEvent {
  return event.type === 'finish';
}

/**
 * Type guard for message events
 */
export function isMessageEvent(event: SSEEvent): event is MessageEvent {
  return event.type === 'message';
}

/**
 * Type guard for assistant-message events
 */
export function isAssistantMessageEvent(event: SSEEvent): event is AssistantMessageEvent {
  return event.type === 'assistant-message';
}

/**
 * Type guard for error events
 * Validates both type and required fields with strict runtime checks
 */
export function isErrorEvent(event: SSEEvent): event is ErrorEvent {
  return event.type === 'error' &&
         'error' in event &&
         typeof event.error === 'string';
}

// ============================================================================
// PARSING FUNCTIONS
// ============================================================================

// Valid SSE event types for runtime validation
const VALID_SSE_EVENT_TYPES = new Set([
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
  'tool-call',
  'tool-call-delta',
  'tool-input-start',
  'tool-input-error',
  'tool-output-error',
  'tool-output-available',
  'source-url',
  'start',
  'start-step',
  'finish-step',
  'finish',
  'message',
  'assistant-message',
  'error'
]);

/**
 * Parse SSE event data string into typed event object
 *
 * @param data - Raw SSE event data string (JSON format)
 * @returns Typed SSE event object
 * @throws Error if parsing fails or required fields are missing
 *
 * @example
 * ```typescript
 * const event = parseSSEEvent('{"type":"text-delta","delta":"Hello"}');
 * if (isTextDeltaEvent(event)) {
 *   console.log(event.delta); // TypeScript knows this exists
 * }
 * ```
 */
export function parseSSEEvent(data: string): SSEEvent {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;

    // Validate required 'type' field
    if (!parsed.type || typeof parsed.type !== 'string') {
      throw new Error('SSE event missing required "type" field');
    }

    // Warn about unrecognized event types (but don't throw - allow extensibility)
    if (!VALID_SSE_EVENT_TYPES.has(parsed.type)) {
      // In development, log a warning. In production, this could be sent to monitoring.
      // eslint-disable-next-line no-console
      if (typeof console !== 'undefined' && console.warn) {
        // eslint-disable-next-line no-console
        console.warn(`[SSE] Unrecognized event type: "${parsed.type}". This may indicate a new event type from the SDK or a malformed event.`);
      }
    }

    return parsed as unknown as SSEEvent;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse SSE event JSON: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Safe parse function that returns null instead of throwing
 * Useful for error recovery scenarios
 *
 * @param data - Raw SSE event data string
 * @returns Typed SSE event object or null if parsing fails
 *
 * @example
 * ```typescript
 * const event = tryParseSSEEvent(data);
 * if (event && isTextDeltaEvent(event)) {
 *   // Handle text delta
 * }
 * ```
 */
export function tryParseSSEEvent(data: string): SSEEvent | null {
  try {
    return parseSSEEvent(data);
  } catch {
    return null;
  }
}

/**
 * Helper to check if an unknown object is a valid SSE event
 * Useful for runtime validation of event objects
 */
export function isSSEEvent(obj: unknown): obj is SSEEvent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    typeof (obj as Record<string, unknown>).type === 'string'
  );
}
