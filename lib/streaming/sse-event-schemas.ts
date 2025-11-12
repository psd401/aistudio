/**
 * Zod Schemas for SSE Event Validation
 *
 * Provides runtime validation for Server-Sent Events to catch field mismatches
 * and malformed events before they cause silent failures.
 *
 * These schemas complement the TypeScript types in sse-event-types.ts by adding
 * runtime validation that can detect issues like:
 * - Missing required fields
 * - Incorrect field types
 * - Field name mismatches (e.g., textDelta vs delta)
 *
 * @see https://github.com/psd401/aistudio/issues/365
 * @see /lib/streaming/sse-event-types.ts
 */

import { z } from 'zod'
import type { SSEEvent } from './sse-event-types'

// ============================================================================
// BASE SCHEMAS
// ============================================================================

/**
 * Base schema for all SSE events
 */
const BaseEventSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  timestamp: z.string().optional()
})

// ============================================================================
// TEXT STREAMING SCHEMAS
// ============================================================================

/**
 * Text start event schema
 */
export const TextStartSchema = BaseEventSchema.extend({
  type: z.literal('text-start'),
  id: z.string()
})

/**
 * Text delta event schema
 * CRITICAL: Validates that the field is named 'delta' NOT 'textDelta'
 * This would have caught bug #355 immediately
 */
export const TextDeltaSchema = BaseEventSchema.extend({
  type: z.literal('text-delta'),
  delta: z.string() // MUST be 'delta' - this catches field name mismatches
})

/**
 * Text end event schema
 */
export const TextEndSchema = BaseEventSchema.extend({
  type: z.literal('text-end'),
  id: z.string()
})

// ============================================================================
// REASONING SCHEMAS (O1/O3 Models)
// ============================================================================

/**
 * Reasoning start event schema
 */
export const ReasoningStartSchema = BaseEventSchema.extend({
  type: z.literal('reasoning-start'),
  id: z.string()
})

/**
 * Reasoning delta event schema
 */
export const ReasoningDeltaSchema = BaseEventSchema.extend({
  type: z.literal('reasoning-delta'),
  delta: z.string(),
  reasoning: z.string().optional()
})

/**
 * Reasoning end event schema
 */
export const ReasoningEndSchema = BaseEventSchema.extend({
  type: z.literal('reasoning-end'),
  id: z.string()
})

// ============================================================================
// TOOL EXECUTION SCHEMAS
// ============================================================================

/**
 * Tool call event schema
 */
export const ToolCallSchema = BaseEventSchema.extend({
  type: z.literal('tool-call'),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()).optional()
})

/**
 * Tool call delta event schema
 */
export const ToolCallDeltaSchema = BaseEventSchema.extend({
  type: z.literal('tool-call-delta'),
  toolCallId: z.string(),
  toolName: z.string(),
  delta: z.string().optional()
})

/**
 * Tool input start event schema
 */
export const ToolInputStartSchema = BaseEventSchema.extend({
  type: z.literal('tool-input-start'),
  toolCallId: z.string(),
  toolName: z.string()
})

/**
 * Tool input error event schema
 */
export const ToolInputErrorSchema = BaseEventSchema.extend({
  type: z.literal('tool-input-error'),
  toolCallId: z.string(),
  toolName: z.string(),
  error: z.string().optional()
})

/**
 * Tool output error event schema
 */
export const ToolOutputErrorSchema = BaseEventSchema.extend({
  type: z.literal('tool-output-error'),
  toolCallId: z.string(),
  errorText: z.string().optional()
})

/**
 * Tool output available event schema
 */
export const ToolOutputAvailableSchema = BaseEventSchema.extend({
  type: z.literal('tool-output-available'),
  toolCallId: z.string(),
  output: z.unknown().optional()
})

// ============================================================================
// LIFECYCLE SCHEMAS
// ============================================================================

/**
 * Stream start event schema
 */
export const StartEventSchema = BaseEventSchema.extend({
  type: z.literal('start')
})

/**
 * Start step event schema
 */
export const StartStepSchema = BaseEventSchema.extend({
  type: z.literal('start-step'),
  stepId: z.string().optional(),
  stepName: z.string().optional()
})

/**
 * Finish step event schema
 */
export const FinishStepSchema = BaseEventSchema.extend({
  type: z.literal('finish-step'),
  stepId: z.string().optional()
})

/**
 * Message part schema
 */
const MessagePartSchema = z.object({
  type: z.string(),
  text: z.string().optional()
}).passthrough() // Allow additional fields

/**
 * Complete message schema
 */
const CompleteMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(MessagePartSchema),
  id: z.string().optional()
})

/**
 * Finish event schema
 */
export const FinishEventSchema = BaseEventSchema.extend({
  type: z.literal('finish'),
  message: CompleteMessageSchema.optional(),
  usage: z.object({
    promptTokens: z.number().optional(),
    completionTokens: z.number().optional(),
    totalTokens: z.number().optional()
  }).optional()
})

// ============================================================================
// MESSAGE SCHEMAS
// ============================================================================

/**
 * Generic message event schema
 */
export const MessageEventSchema = BaseEventSchema.extend({
  type: z.literal('message'),
  parts: z.array(MessagePartSchema).optional(),
  role: z.enum(['user', 'assistant', 'system']).optional()
})

/**
 * Assistant message event schema
 */
export const AssistantMessageSchema = BaseEventSchema.extend({
  type: z.literal('assistant-message'),
  parts: z.array(MessagePartSchema).optional(),
  role: z.literal('assistant')
})

// ============================================================================
// ERROR SCHEMA
// ============================================================================

/**
 * Error event schema
 */
export const ErrorEventSchema = BaseEventSchema.extend({
  type: z.literal('error'),
  error: z.string(),
  code: z.string().optional(),
  stack: z.string().optional()
})

// ============================================================================
// DISCRIMINATED UNION
// ============================================================================

/**
 * Discriminated union of all SSE event schemas
 * Enables exhaustive validation and type narrowing
 */
export const SSEEventSchema = z.discriminatedUnion('type', [
  TextStartSchema,
  TextDeltaSchema,
  TextEndSchema,
  ReasoningStartSchema,
  ReasoningDeltaSchema,
  ReasoningEndSchema,
  ToolCallSchema,
  ToolCallDeltaSchema,
  ToolInputStartSchema,
  ToolInputErrorSchema,
  ToolOutputErrorSchema,
  ToolOutputAvailableSchema,
  StartEventSchema,
  StartStepSchema,
  FinishStepSchema,
  FinishEventSchema,
  MessageEventSchema,
  AssistantMessageSchema,
  ErrorEventSchema
])

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validation result with helpful error messages
 */
export interface ValidationResult {
  /** Whether validation succeeded */
  success: boolean
  /** The validated event if successful */
  data?: SSEEvent
  /** Error details if validation failed */
  error?: {
    message: string
    issues: Array<{
      path: string[]
      message: string
      expected?: string
      received?: string
    }>
    /** Helpful hint for resolving the issue */
    hint?: string
  }
}

/**
 * Validate an SSE event with detailed error reporting
 *
 * @param event - The event to validate
 * @returns Validation result with typed data or detailed errors
 *
 * @example
 * ```typescript
 * const result = validateSSEEvent(parsedEvent)
 * if (result.success) {
 *   // result.data is typed as SSEEvent
 *   handleEvent(result.data)
 * } else {
 *   // result.error contains detailed validation errors
 *   console.error(result.error.message, result.error.hint)
 * }
 * ```
 */
export function validateSSEEvent(event: unknown): ValidationResult {
  const result = SSEEventSchema.safeParse(event)

  if (result.success) {
    return {
      success: true,
      data: result.data as SSEEvent
    }
  }

  // Generate helpful error messages
  const issues = result.error.issues.map(issue => ({
    path: issue.path.map(String),
    message: issue.message,
    expected: 'expected' in issue ? String(issue.expected) : undefined,
    received: 'received' in issue ? String(issue.received) : undefined
  }))

  // Generate helpful hints based on error patterns
  let hint: string | undefined

  // Check for field name mismatches (like textDelta vs delta)
  // Zod v4 may say "expected string, received undefined" for missing required fields
  const fieldNameIssues = issues.filter(i =>
    i.message.includes('Unrecognized key') ||
    i.message.includes('Required') ||
    i.message.includes('received undefined') ||
    (i.message.includes('Invalid input') && i.path.includes('delta'))
  )

  if (fieldNameIssues.length > 0) {
    hint = 'Field name mismatch detected. This may indicate an AI SDK compatibility issue or version mismatch. Check that field names match the Vercel AI SDK v5 specification.'
  }

  // Check for type mismatches
  const typeIssues = issues.filter(i => i.message.includes('Expected') || i.message.includes('invalid_type'))
  if (typeIssues.length > 0 && !hint) {
    hint = 'Type mismatch detected. Verify that the event fields have the correct data types.'
  }

  return {
    success: false,
    error: {
      message: `SSE event validation failed: ${result.error.message}`,
      issues,
      hint
    }
  }
}

/**
 * Validate a specific event type with its dedicated schema
 *
 * @param event - The event to validate
 * @param eventType - The expected event type
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const result = validateEventType(event, 'text-delta')
 * if (result.success) {
 *   // Event is confirmed to be a text-delta with correct fields
 * }
 * ```
 */
export function validateEventType(event: unknown, eventType: string): ValidationResult {
  // Map event types to their schemas
  const schemaMap: Record<string, z.ZodTypeAny> = {
    'text-start': TextStartSchema,
    'text-delta': TextDeltaSchema,
    'text-end': TextEndSchema,
    'reasoning-start': ReasoningStartSchema,
    'reasoning-delta': ReasoningDeltaSchema,
    'reasoning-end': ReasoningEndSchema,
    'tool-call': ToolCallSchema,
    'tool-call-delta': ToolCallDeltaSchema,
    'tool-input-start': ToolInputStartSchema,
    'tool-input-error': ToolInputErrorSchema,
    'tool-output-error': ToolOutputErrorSchema,
    'tool-output-available': ToolOutputAvailableSchema,
    'start': StartEventSchema,
    'start-step': StartStepSchema,
    'finish-step': FinishStepSchema,
    'finish': FinishEventSchema,
    'message': MessageEventSchema,
    'assistant-message': AssistantMessageSchema,
    'error': ErrorEventSchema
  }

  const schema = schemaMap[eventType]
  if (!schema) {
    return {
      success: false,
      error: {
        message: `Unknown event type: ${eventType}`,
        issues: [],
        hint: 'This event type is not recognized. It may be a new SDK feature or a malformed event.'
      }
    }
  }

  const result = schema.safeParse(event)

  if (result.success) {
    return {
      success: true,
      data: result.data as SSEEvent
    }
  }

  const issues = result.error.issues.map(issue => ({
    path: issue.path.map(String),
    message: issue.message
  }))

  return {
    success: false,
    error: {
      message: `Event validation failed for type '${eventType}': ${result.error.message}`,
      issues
    }
  }
}

/**
 * Extract field names from an event for mismatch detection
 */
export function extractEventFields(event: unknown): string[] {
  if (typeof event !== 'object' || event === null) {
    return []
  }
  return Object.keys(event)
}

/**
 * Generate a helpful error message for developers
 */
export function generateValidationErrorMessage(result: ValidationResult): string {
  if (result.success) {
    return 'Validation succeeded'
  }

  if (!result.error) {
    return 'Validation failed with unknown error'
  }

  let message = result.error.message

  if (result.error.issues.length > 0) {
    message += '\n\nIssues:'
    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'root'
      message += `\n  - ${path}: ${issue.message}`
      if (issue.expected) {
        message += ` (expected: ${issue.expected})`
      }
      if (issue.received) {
        message += ` (received: ${issue.received})`
      }
    }
  }

  if (result.error.hint) {
    message += `\n\n💡 Hint: ${result.error.hint}`
  }

  return message
}
