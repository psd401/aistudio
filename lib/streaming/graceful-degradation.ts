/**
 * Graceful Degradation for Unknown SSE Event Types
 *
 * Provides fallback handling for unknown or future SSE event types to ensure
 * forward compatibility and prevent silent failures when new SDK versions introduce
 * new event types.
 *
 * Key Features:
 * - Intelligent text extraction from unknown events
 * - Non-breaking handling of unrecognized events
 * - Detailed logging for debugging
 * - Forward compatibility with future AI SDK versions
 *
 * @see https://github.com/psd401/aistudio/issues/365
 */

import { createLogger } from '@/lib/client-logger'
import type { SSEMonitor } from './sse-monitoring'

const log = createLogger({ moduleName: 'sse-graceful-degradation' })

/**
 * Result of attempting to extract content from an unknown event
 */
export interface ContentExtractionResult {
  /** Whether content was successfully extracted */
  success: boolean
  /** The extracted text content (if any) */
  text?: string
  /** The field from which content was extracted */
  extractedFrom?: string
  /** Hint about what was found */
  hint?: string
}

/**
 * Context for processing unknown events
 */
export interface UnknownEventContext {
  /** Current accumulated text for the stream */
  accumulatedText: string
  /** Monitor instance for recording unknown events */
  monitor?: SSEMonitor
  /** Whether to log verbose information */
  verbose?: boolean
}

/**
 * Text extraction fields in priority order
 * These are common field names across different AI providers and SDK versions
 */
const TEXT_EXTRACTION_FIELDS = [
  'delta',      // Vercel AI SDK standard
  'text',       // Common alternative
  'content',    // Generic content field
  'message',    // Message-based events
  'data',       // Generic data field
  'value',      // Generic value field
  'textDelta'   // Legacy/variant field names
] as const

/**
 * Nested path extraction patterns
 * Some events have nested structures, check these paths
 */
const NESTED_TEXT_PATHS = [
  ['content', 'text'],
  ['data', 'text'],
  ['message', 'content'],
  ['delta', 'text'],
  ['text', 'content']
] as const

/**
 * Extract text content from an unknown SSE event
 *
 * Attempts multiple strategies to find textual content:
 * 1. Check top-level text fields in priority order
 * 2. Check nested structures
 * 3. Check for array content
 *
 * @param event - The unknown event object
 * @returns Extraction result with text if found
 *
 * @example
 * ```typescript
 * const event = { type: 'new-event-type', someTextField: 'Hello!' }
 * const result = extractTextFromUnknownEvent(event)
 * if (result.success) {
 *   console.log(result.text) // 'Hello!'
 *   console.log(result.extractedFrom) // 'someTextField'
 * }
 * ```
 */
export function extractTextFromUnknownEvent(event: Record<string, unknown>): ContentExtractionResult {
  // Strategy 1: Check known text field names in priority order
  for (const field of TEXT_EXTRACTION_FIELDS) {
    const value = event[field]
    if (typeof value === 'string' && value.length > 0) {
      return {
        success: true,
        text: value,
        extractedFrom: field,
        hint: `Found text in standard field '${field}'`
      }
    }
  }

  // Strategy 2: Check nested paths
  for (const path of NESTED_TEXT_PATHS) {
    let current: unknown = event
    let validPath = true

    for (const key of path) {
      if (current && typeof current === 'object' && key in current) {
        current = (current as Record<string, unknown>)[key]
      } else {
        validPath = false
        break
      }
    }

    if (validPath && typeof current === 'string' && current.length > 0) {
      return {
        success: true,
        text: current,
        extractedFrom: path.join('.'),
        hint: `Found text in nested path '${path.join('.')}'`
      }
    }
  }

  // Strategy 3: Check for parts array (message-style events)
  if ('parts' in event && Array.isArray(event.parts)) {
    for (const part of event.parts) {
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string'
      ) {
        return {
          success: true,
          text: part.text,
          extractedFrom: 'parts[].text',
          hint: 'Found text in parts array (message format)'
        }
      }
    }
  }

  // Strategy 4: Last resort - check all string values
  const allKeys = Object.keys(event)
  for (const key of allKeys) {
    const value = event[key]
    // Skip metadata fields
    if (key === 'type' || key === 'id' || key === 'timestamp') {
      continue
    }

    if (typeof value === 'string' && value.length > 0) {
      log.info('Found text in unexpected field', {
        field: key,
        sample: value.substring(0, 50),
        hint: 'This may be a new event format'
      })

      return {
        success: true,
        text: value,
        extractedFrom: key,
        hint: `Found text in non-standard field '${key}' - this may indicate a new event format`
      }
    }
  }

  return {
    success: false,
    hint: 'No text content found in event'
  }
}

/**
 * Handle an unknown SSE event with graceful degradation
 *
 * This function:
 * 1. Records the unknown event type in the monitor
 * 2. Attempts to extract text content
 * 3. Logs detailed information for debugging
 * 4. Returns extracted content if found
 *
 * @param event - The unknown event
 * @param context - Processing context
 * @returns Extraction result
 *
 * @example
 * ```typescript
 * const monitor = new SSEMonitor()
 * const context = { accumulatedText: '', monitor }
 *
 * const result = handleUnknownEvent(unknownEvent, context)
 * if (result.success && result.text) {
 *   context.accumulatedText += result.text
 *   // Yield updated content
 * }
 * ```
 */
export function handleUnknownEvent(
  event: Record<string, unknown>,
  context: UnknownEventContext
): ContentExtractionResult {
  const eventType = typeof event.type === 'string' ? event.type : 'unknown'

  // Record the unknown event in the monitor
  if (context.monitor) {
    context.monitor.recordUnknownType(eventType, event)
  }

  // Log information about the unknown event
  log.info('Unknown SSE event type encountered (non-critical)', {
    type: eventType,
    fields: Object.keys(event),
    sample: JSON.stringify(event).substring(0, 200),
    hint: 'Attempting content extraction for forward compatibility'
  })

  // Attempt to extract text content
  const extractionResult = extractTextFromUnknownEvent(event)

  if (extractionResult.success && extractionResult.text) {
    log.info('Successfully extracted text from unknown event', {
      type: eventType,
      extractedFrom: extractionResult.extractedFrom,
      textLength: extractionResult.text.length,
      hint: extractionResult.hint
    })
  } else if (context.verbose) {
    log.debug('No text content found in unknown event', {
      type: eventType,
      fields: Object.keys(event),
      hint: 'Event may be metadata-only or use an unexpected structure'
    })
  }

  return extractionResult
}

/**
 * Process an unknown event and update the accumulated text
 *
 * Higher-level function that handles the full processing flow:
 * 1. Handle unknown event
 * 2. Extract text if available
 * 3. Update accumulated text
 * 4. Return whether content should be yielded
 *
 * @param event - The unknown event
 * @param context - Processing context (will be mutated if text is extracted)
 * @returns Whether new content should be yielded to the UI
 *
 * @example
 * ```typescript
 * if (processUnknownEvent(event, context)) {
 *   yield {
 *     content: [{ type: 'text', text: context.accumulatedText }]
 *   }
 * }
 * ```
 */
export function processUnknownEvent(
  event: Record<string, unknown>,
  context: UnknownEventContext
): boolean {
  const result = handleUnknownEvent(event, context)

  if (result.success && result.text) {
    // Update accumulated text with extracted content
    context.accumulatedText += result.text
    return true // Indicate that content should be yielded
  }

  return false // No new content to yield
}

/**
 * Check if an event is potentially a text-bearing event
 *
 * Quick heuristic check before attempting full extraction
 *
 * @param event - The event to check
 * @returns Whether the event likely contains text content
 */
export function isLikelyTextEvent(event: Record<string, unknown>): boolean {
  // Check for any of the common text field names
  for (const field of TEXT_EXTRACTION_FIELDS) {
    if (field in event && typeof event[field] === 'string') {
      return true
    }
  }

  // Check for parts array
  if ('parts' in event && Array.isArray(event.parts) && event.parts.length > 0) {
    return true
  }

  return false
}

/**
 * Generate a development-friendly error message for unknown events
 *
 * Helps developers understand what happened and how to address it
 *
 * @param event - The unknown event
 * @param extraction - The extraction result
 * @returns Formatted message for developers
 */
export function generateUnknownEventMessage(
  event: Record<string, unknown>,
  extraction: ContentExtractionResult
): string {
  const eventType = typeof event.type === 'string' ? event.type : 'unknown'
  const fields = Object.keys(event).join(', ')

  let message = `Encountered unknown SSE event type: "${eventType}"\n`
  message += `Fields: ${fields}\n`

  if (extraction.success) {
    message += `✅ Successfully extracted text from field: ${extraction.extractedFrom}\n`
    message += `Content length: ${extraction.text?.length || 0} characters\n`
  } else {
    message += `❌ Could not extract text content\n`
    message += `This may be a metadata-only event or use an unexpected structure.\n`
  }

  message += `\nSuggestions:\n`
  message += `1. Check if this is a new AI SDK version with new event types\n`
  message += `2. Verify provider adapter implementation\n`
  message += `3. Consider adding explicit support for this event type in sse-event-types.ts\n`

  return message
}
