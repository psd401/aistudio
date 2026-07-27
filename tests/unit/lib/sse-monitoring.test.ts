/**
 * Tests for SSE Monitoring
 *
 * Comprehensive test coverage for the SSE monitoring system introduced in issue #365
 * to prevent bugs like #355 from occurring.
 *
 * @see https://github.com/psd401/aistudio.psd401.ai/issues/365
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { SSEMonitor, createSSEMonitor } from '@/lib/streaming/sse-monitoring'

describe('SSEMonitor', () => {
  let monitor: SSEMonitor

  beforeEach(() => {
    jest.useFakeTimers()
    monitor = new SSEMonitor({ verbose: false })
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  describe('Event Recording', () => {
    it('should record event types and counts', () => {
      monitor.recordEvent('text-delta')
      monitor.recordEvent('text-delta')
      monitor.recordEvent('text-start')

      const metrics = monitor.getMetrics()
      expect(metrics.eventCounts.get('text-delta')).toBe(2)
      expect(metrics.eventCounts.get('text-start')).toBe(1)
      expect(metrics.totalEvents).toBe(3)
    })

    it('should update last event time on each event', () => {
      const startTime = Date.now()
      monitor.recordEvent('text-delta')

      jest.advanceTimersByTime(1000)
      monitor.recordEvent('text-delta')

      const metrics = monitor.getMetrics()
      expect(metrics.lastEventTime).toBeGreaterThan(startTime)
    })
  })

  describe('Parse Error Tracking', () => {
    it('should record parse errors', () => {
      const error = new Error('Invalid JSON')
      const data = '{invalid json}'

      monitor.recordParseError(error, data)

      const metrics = monitor.getMetrics()
      expect(metrics.parseErrors).toBe(1)
      expect(metrics.parseErrorDetails).toHaveLength(1)
      expect(metrics.parseErrorDetails[0].error.message).toBe('Invalid JSON')
      expect(metrics.parseErrorDetails[0].dataSample).toContain('{invalid json}')
    })

    it('should limit parse error details storage', () => {
      const limitedMonitor = new SSEMonitor({ maxParseErrorDetails: 3 })

      for (let i = 0; i < 10; i++) {
        limitedMonitor.recordParseError(new Error(`Error ${i}`), `data ${i}`)
      }

      const metrics = limitedMonitor.getMetrics()
      expect(metrics.parseErrors).toBe(10)
      expect(metrics.parseErrorDetails).toHaveLength(3) // Limited to 3
    })
  })

  describe('Unknown Event Type Detection', () => {
    it('should record unknown event types', () => {
      const unknownEvent = { type: 'new-event-type', someField: 'value' }

      monitor.recordUnknownType('new-event-type', unknownEvent)

      const metrics = monitor.getMetrics()
      expect(metrics.unknownTypes).toHaveLength(1)
      expect(metrics.unknownTypes[0].type).toBe('new-event-type')
      expect(metrics.unknownTypes[0].fields).toContain('someField')
      expect(metrics.unknownTypes[0].count).toBe(1)
    })

    it('should increment count for repeated unknown types', () => {
      monitor.recordUnknownType('new-event-type')
      monitor.recordUnknownType('new-event-type')
      monitor.recordUnknownType('new-event-type')

      const metrics = monitor.getMetrics()
      expect(metrics.unknownTypes).toHaveLength(1)
      expect(metrics.unknownTypes[0].count).toBe(3)
    })

    it('should limit unknown type storage', () => {
      const limitedMonitor = new SSEMonitor({ maxUnknownTypes: 2 })

      limitedMonitor.recordUnknownType('type-1')
      limitedMonitor.recordUnknownType('type-2')
      limitedMonitor.recordUnknownType('type-3') // Should not be added to array

      const metrics = limitedMonitor.getMetrics()
      expect(metrics.unknownTypes).toHaveLength(2)
    })
  })

  describe('Field Mismatch Detection', () => {
    it('should detect missing expected fields', () => {
      const receivedFields = ['type', 'textDelta', 'id'] // Wrong field name!
      monitor.recordFieldMismatch('delta', receivedFields, 'text-delta')

      const metrics = monitor.getMetrics()
      expect(metrics.fieldMismatches).toHaveLength(1)
      expect(metrics.fieldMismatches[0].expected).toBe('delta')
      expect(metrics.fieldMismatches[0].received).toEqual(receivedFields)
      expect(metrics.fieldMismatches[0].eventType).toBe('text-delta')
      expect(metrics.hasErrors).toBe(true)
    })

    it('should not record mismatch if field exists', () => {
      const receivedFields = ['type', 'delta', 'id'] // Correct field name
      monitor.recordFieldMismatch('delta', receivedFields, 'text-delta')

      const metrics = monitor.getMetrics()
      expect(metrics.fieldMismatches).toHaveLength(0)
      expect(metrics.hasErrors).toBe(false)
    })

    it('should validate multiple required fields', () => {
      const event = { type: 'tool-call', toolCallId: '123' } // Missing toolName
      const isValid = monitor.validateEventFields(event, ['toolCallId', 'toolName'])

      expect(isValid).toBe(false)

      const metrics = monitor.getMetrics()
      expect(metrics.fieldMismatches).toHaveLength(1)
      expect(metrics.fieldMismatches[0].expected).toBe('toolName')
    })
  })

  describe('Stream Completion', () => {
    it('should complete monitoring and calculate metrics', () => {
      monitor.recordEvent('text-delta')
      monitor.recordEvent('text-delta')
      monitor.recordEvent('text-start')

      jest.advanceTimersByTime(5000) // 5 seconds

      const metrics = monitor.complete()

      expect(metrics.completed).toBe(true)
      expect(metrics.endTime).toBeDefined()
      expect(metrics.totalEvents).toBe(3)
      expect(metrics.endTime! - metrics.startTime).toBeGreaterThanOrEqual(5000)
    })

    it('should stop heartbeat monitoring on completion', () => {
      const completedMetrics = monitor.complete()

      // Advance time significantly - should not trigger heartbeat warnings
      jest.advanceTimersByTime(60000)

      expect(completedMetrics.completed).toBe(true)
    })
  })

  describe('Metrics Snapshot', () => {
    it('should return current metrics without completing', () => {
      monitor.recordEvent('text-delta')

      const snapshot1 = monitor.getMetrics()
      expect(snapshot1.completed).toBe(false)
      expect(snapshot1.totalEvents).toBe(1)

      monitor.recordEvent('text-delta')

      const snapshot2 = monitor.getMetrics()
      expect(snapshot2.completed).toBe(false)
      expect(snapshot2.totalEvents).toBe(2)

      // Monitor should still be active
      const finalMetrics = monitor.complete()
      expect(finalMetrics.completed).toBe(true)
    })
  })

  describe('Factory Function', () => {
    it('should create monitor with default configuration', () => {
      const factoryMonitor = createSSEMonitor({ executionId: 123 })

      factoryMonitor.recordEvent('text-delta')

      const metrics = factoryMonitor.getMetrics()
      expect(metrics.totalEvents).toBe(1)
    })
  })

  describe('Configuration', () => {
    it('should respect custom configuration', () => {
      const customMonitor = new SSEMonitor({
        verbose: true,
        maxParseErrorDetails: 5,
        maxUnknownTypes: 10,
        context: { executionId: 456 }
      })

      expect(customMonitor).toBeDefined()
      const metrics = customMonitor.getMetrics()
      expect(metrics.totalEvents).toBe(0)
    })
  })

  describe('Reset Functionality', () => {
    it('should reset all metrics', () => {
      monitor.recordEvent('text-delta')
      monitor.recordParseError(new Error('test'), 'data')
      monitor.recordUnknownType('unknown')
      monitor.recordFieldMismatch('delta', ['textDelta'], 'text-delta')

      monitor.reset()

      const metrics = monitor.getMetrics()
      expect(metrics.totalEvents).toBe(0)
      expect(metrics.parseErrors).toBe(0)
      expect(metrics.unknownTypes).toHaveLength(0)
      expect(metrics.fieldMismatches).toHaveLength(0)
      expect(metrics.completed).toBe(false)
      expect(metrics.hasErrors).toBe(false)
    })
  })
})
