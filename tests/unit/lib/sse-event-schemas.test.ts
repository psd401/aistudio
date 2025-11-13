/**
 * Tests for SSE Event Schemas (Zod Validation)
 *
 * Tests the runtime validation that would have caught bug #355
 * where field names didn't match SDK expectations.
 *
 * @see https://github.com/psd401/aistudio.psd401.ai/issues/365
 * @see https://github.com/psd401/aistudio.psd401.ai/issues/355
 */

import { describe, it, expect } from '@jest/globals'
import {
  validateSSEEvent,
  validateEventType,
  extractEventFields,
  generateValidationErrorMessage
} from '@/lib/streaming/sse-event-schemas'

describe('SSE Event Schemas', () => {
  describe('TextDeltaSchema', () => {
    it('should validate correct text-delta events', () => {
      const validEvent = {
        type: 'text-delta',
        delta: 'Hello world'
      }

      const result = validateSSEEvent(validEvent)

      expect(result.success).toBe(true)
      expect(result.data).toEqual(validEvent)
    })

    it('should reject text-delta with wrong field name (textDelta)', () => {
      // This is the bug #355 scenario!
      const invalidEvent = {
        type: 'text-delta',
        textDelta: 'Hello world' // Wrong field name
      }

      const result = validateSSEEvent(invalidEvent)

      expect(result.success).toBe(false)
      expect(result.error?.hint).toContain('Field name mismatch')
    })

    it('should reject text-delta with missing delta field', () => {
      const invalidEvent = {
        type: 'text-delta'
        // Missing delta field
      }

      const result = validateSSEEvent(invalidEvent)

      expect(result.success).toBe(false)
      expect(result.error?.issues).toHaveLength(1)
    })

    it('should reject text-delta with wrong delta type', () => {
      const invalidEvent = {
        type: 'text-delta',
        delta: 123 // Should be string
      }

      const result = validateSSEEvent(invalidEvent)

      expect(result.success).toBe(false)
    })
  })

  describe('TextStartSchema', () => {
    it('should validate correct text-start events', () => {
      const validEvent = {
        type: 'text-start',
        id: 'text-123'
      }

      const result = validateSSEEvent(validEvent)

      expect(result.success).toBe(true)
      expect(result.data).toEqual(validEvent)
    })

    it('should reject text-start without id', () => {
      const invalidEvent = {
        type: 'text-start'
      }

      const result = validateSSEEvent(invalidEvent)

      expect(result.success).toBe(false)
    })
  })

  describe('ToolCallSchema', () => {
    it('should validate correct tool-call events', () => {
      const validEvent = {
        type: 'tool-call',
        toolCallId: 'call-123',
        toolName: 'web_search',
        args: {
          query: 'test query'
        }
      }

      const result = validateSSEEvent(validEvent)

      expect(result.success).toBe(true)
    })

    it('should validate tool-call without optional args', () => {
      const validEvent = {
        type: 'tool-call',
        toolCallId: 'call-123',
        toolName: 'web_search'
      }

      const result = validateSSEEvent(validEvent)

      expect(result.success).toBe(true)
    })

    it('should reject tool-call with missing required fields', () => {
      const invalidEvent = {
        type: 'tool-call',
        toolCallId: 'call-123'
        // Missing toolName
      }

      const result = validateSSEEvent(invalidEvent)

      expect(result.success).toBe(false)
    })
  })

  describe('ErrorEventSchema', () => {
    it('should validate error events', () => {
      const validEvent = {
        type: 'error',
        error: 'Something went wrong',
        code: 'ERR_STREAM_FAILED',
        stack: 'Error: Something went wrong\n  at...'
      }

      const result = validateSSEEvent(validEvent)

      expect(result.success).toBe(true)
    })

    it('should validate error events without optional fields', () => {
      const validEvent = {
        type: 'error',
        error: 'Something went wrong'
      }

      const result = validateSSEEvent(validEvent)

      expect(result.success).toBe(true)
    })

    it('should reject error events without error message', () => {
      const invalidEvent = {
        type: 'error',
        code: 'ERR_UNKNOWN'
        // Missing error field
      }

      const result = validateSSEEvent(invalidEvent)

      expect(result.success).toBe(false)
    })
  })

  describe('validateEventType', () => {
    it('should validate specific event types', () => {
      const event = {
        type: 'text-delta',
        delta: 'Hello'
      }

      const result = validateEventType(event, 'text-delta')

      expect(result.success).toBe(true)
      expect(result.data).toEqual(event)
    })

    it('should reject events with wrong type', () => {
      const event = {
        type: 'text-delta',
        delta: 'Hello'
      }

      const result = validateEventType(event, 'text-start')

      expect(result.success).toBe(false)
    })

    it('should return error for unknown event types', () => {
      const event = {
        type: 'unknown-type',
        field: 'value'
      }

      const result = validateEventType(event, 'unknown-type')

      expect(result.success).toBe(false)
      expect(result.error?.hint).toContain('not recognized')
    })
  })

  describe('Discriminated Union', () => {
    it('should validate events using discriminated union', () => {
      const events = [
        { type: 'text-delta', delta: 'Hello' },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-end', id: 'text-1' },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'search' },
        { type: 'error', error: 'Failed' }
      ]

      events.forEach(event => {
        const result = validateSSEEvent(event)
        expect(result.success).toBe(true)
      })
    })
  })

  describe('Field Extraction', () => {
    it('should extract field names from event', () => {
      const event = {
        type: 'text-delta',
        delta: 'Hello',
        id: '123',
        timestamp: '2025-01-01'
      }

      const fields = extractEventFields(event)

      expect(fields).toContain('type')
      expect(fields).toContain('delta')
      expect(fields).toContain('id')
      expect(fields).toContain('timestamp')
      expect(fields).toHaveLength(4)
    })

    it('should return empty array for non-object', () => {
      expect(extractEventFields(null)).toEqual([])
      expect(extractEventFields(undefined)).toEqual([])
      expect(extractEventFields('string')).toEqual([])
      expect(extractEventFields(123)).toEqual([])
    })
  })

  describe('Error Message Generation', () => {
    it('should generate helpful error message for field mismatch', () => {
      const invalidEvent = {
        type: 'text-delta',
        textDelta: 'Wrong field'
      }

      const result = validateSSEEvent(invalidEvent)
      expect(result.success).toBe(false)

      if (!result.success && result.error) {
        const message = generateValidationErrorMessage(result)

        expect(message).toContain('validation failed')
        expect(message).toContain('Hint')
        expect(message).toContain('Field name mismatch')
      }
    })

    it('should generate error message for missing field', () => {
      const invalidEvent = {
        type: 'text-delta'
      }

      const result = validateSSEEvent(invalidEvent)
      expect(result.success).toBe(false)

      if (!result.success && result.error) {
        const message = generateValidationErrorMessage(result)

        expect(message).toContain('validation failed')
        expect(message).toContain('Issues:')
      }
    })

    it('should generate error message for type mismatch', () => {
      const invalidEvent = {
        type: 'text-delta',
        delta: 123 // Should be string
      }

      const result = validateSSEEvent(invalidEvent)
      expect(result.success).toBe(false)

      if (!result.success && result.error) {
        const message = generateValidationErrorMessage(result)

        expect(message).toContain('validation failed')
      }
    })
  })

  describe('Bug #355 Regression Prevention', () => {
    it('should catch the exact bug from #355', () => {
      // This is the exact scenario from bug #355:
      // SDK sent 'textDelta' but we expected 'delta'
      const buggyEvent = {
        type: 'text-delta',
        textDelta: 'This field name is wrong!'
      }

      const result = validateSSEEvent(buggyEvent)

      // This validation would have caught the bug!
      expect(result.success).toBe(false)
      expect(result.error?.hint).toContain('Field name mismatch')

      // The error message should be helpful
      if (!result.success && result.error) {
        const message = generateValidationErrorMessage(result)
        expect(message).toContain('SDK')
        expect(message).toContain('compatibility')
      }
    })

    it('should validate correct field name (delta)', () => {
      // This is the correct format
      const correctEvent = {
        type: 'text-delta',
        delta: 'Correct field name!'
      }

      const result = validateSSEEvent(correctEvent)

      expect(result.success).toBe(true)
      expect(result.data).toEqual(correctEvent)
    })
  })

  describe('Optional Fields', () => {
    it('should allow optional fields', () => {
      const eventWithOptional = {
        type: 'text-delta',
        delta: 'Hello',
        id: 'optional-id',
        timestamp: '2025-01-01T00:00:00Z'
      }

      const result = validateSSEEvent(eventWithOptional)

      expect(result.success).toBe(true)
    })

    it('should work without optional fields', () => {
      const minimalEvent = {
        type: 'text-delta',
        delta: 'Hello'
      }

      const result = validateSSEEvent(minimalEvent)

      expect(result.success).toBe(true)
    })
  })

  describe('Complex Events', () => {
    it('should validate finish events with usage', () => {
      const finishEvent = {
        type: 'finish',
        message: {
          role: 'assistant' as const,
          parts: [
            { type: 'text', text: 'Complete message' }
          ]
        },
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150
        }
      }

      const result = validateSSEEvent(finishEvent)

      expect(result.success).toBe(true)
    })

    it('should validate message events with parts', () => {
      const messageEvent = {
        type: 'message',
        role: 'assistant' as const,
        parts: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'World' }
        ]
      }

      const result = validateSSEEvent(messageEvent)

      expect(result.success).toBe(true)
    })
  })

  describe('Schema Performance', () => {
    it('should validate quickly with many events', () => {
      const events = Array.from({ length: 1000 }, (_, i) => ({
        type: 'text-delta',
        delta: `Message ${i}`
      }))

      const startTime = Date.now()

      events.forEach(event => {
        validateSSEEvent(event)
      })

      const duration = Date.now() - startTime

      // Should complete in reasonable time (< 100ms for 1000 events)
      expect(duration).toBeLessThan(100)
    })
  })
})
