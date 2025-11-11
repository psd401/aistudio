/**
 * SSE Monitoring Class
 *
 * Tracks metrics and detects issues in Server-Sent Events streaming in real-time.
 * This monitoring system is designed to catch issues like #355 (field name mismatches)
 * and provide comprehensive visibility into streaming health.
 *
 * Features:
 * - Event type tracking and counting
 * - Parse error detection and logging
 * - Unknown event type detection
 * - Field mismatch detection (critical for catching SDK version mismatches)
 * - Connection health monitoring with heartbeat tracking
 * - Performance metrics (duration, events per second)
 * - Detailed completion reports
 *
 * @see https://github.com/psd401/aistudio/issues/365
 */

import { createLogger } from '@/lib/client-logger'
import type { SSEEvent } from './sse-event-types'

const log = createLogger({ moduleName: 'sse-monitoring' })

/**
 * Field mismatch information for debugging SDK version issues
 */
export interface FieldMismatch {
  /** The expected field name */
  expected: string
  /** The actual fields present in the event */
  received: string[]
  /** The event type where the mismatch occurred */
  eventType: string
  /** Timestamp when the mismatch was detected */
  timestamp: number
}

/**
 * Parse error information for debugging malformed events
 */
export interface ParseError {
  /** The error that occurred */
  error: Error
  /** Sample of the raw data that failed to parse */
  dataSample: string
  /** Timestamp when the error occurred */
  timestamp: number
}

/**
 * Unknown event type information for forward compatibility
 */
export interface UnknownEventInfo {
  /** The unknown event type */
  type: string
  /** Fields present in the unknown event */
  fields: string[]
  /** Sample of the event data */
  sample: string
  /** Timestamp when first encountered */
  firstSeen: number
  /** Number of times this unknown type was seen */
  count: number
}

/**
 * Comprehensive SSE streaming metrics
 */
export interface SSEMetrics {
  /** Count of each event type received */
  eventCounts: Map<string, number>
  /** Total number of parse errors */
  parseErrors: number
  /** List of parse error details */
  parseErrorDetails: ParseError[]
  /** List of unknown event types encountered */
  unknownTypes: UnknownEventInfo[]
  /** List of field mismatches detected */
  fieldMismatches: FieldMismatch[]
  /** Stream start timestamp */
  startTime: number
  /** Stream end timestamp (set on completion) */
  endTime?: number
  /** Last event timestamp for connection health */
  lastEventTime: number
  /** Total events processed */
  totalEvents: number
  /** Stream was completed successfully */
  completed: boolean
  /** Stream encountered errors */
  hasErrors: boolean
}

/**
 * Configuration options for SSE monitoring
 */
export interface SSEMonitorConfig {
  /** Enable verbose logging for development */
  verbose?: boolean
  /** Maximum parse errors to track in detail (prevents memory bloat) */
  maxParseErrorDetails?: number
  /** Maximum unknown event types to track */
  maxUnknownTypes?: number
  /** Heartbeat interval in milliseconds for connection health checks */
  heartbeatInterval?: number
  /** Custom context for this monitor instance */
  context?: Record<string, unknown>
}

/**
 * SSE Monitor Class
 *
 * Provides real-time monitoring and metrics collection for SSE streams.
 * Each stream should create its own monitor instance.
 *
 * @example
 * ```typescript
 * const monitor = new SSEMonitor({ verbose: true, context: { executionId: 123 } })
 *
 * // Record events
 * monitor.recordEvent('text-delta')
 *
 * // Check for field mismatches (critical for bug detection)
 * monitor.recordFieldMismatch('delta', ['textDelta'], 'text-delta')
 *
 * // On completion
 * const metrics = monitor.complete()
 * ```
 */
export class SSEMonitor {
  private metrics: SSEMetrics
  private config: Required<SSEMonitorConfig>
  private unknownTypeMap: Map<string, UnknownEventInfo>
  private heartbeatCheckInterval?: NodeJS.Timeout

  constructor(config: SSEMonitorConfig = {}) {
    this.config = {
      verbose: config.verbose ?? process.env.NODE_ENV === 'development',
      maxParseErrorDetails: config.maxParseErrorDetails ?? 10,
      maxUnknownTypes: config.maxUnknownTypes ?? 20,
      heartbeatInterval: config.heartbeatInterval ?? 30000, // 30 seconds
      context: config.context ?? {}
    }

    this.metrics = {
      eventCounts: new Map(),
      parseErrors: 0,
      parseErrorDetails: [],
      unknownTypes: [],
      fieldMismatches: [],
      startTime: Date.now(),
      lastEventTime: Date.now(),
      totalEvents: 0,
      completed: false,
      hasErrors: false
    }

    this.unknownTypeMap = new Map()

    // Start heartbeat monitoring for connection health
    this.startHeartbeatMonitoring()

    if (this.config.verbose) {
      log.info('SSE monitoring started', {
        ...this.config.context,
        startTime: new Date(this.metrics.startTime).toISOString()
      })
    }
  }

  /**
   * Record an event being processed
   * Updates event counts and connection health timestamp
   */
  recordEvent(type: string): void {
    this.metrics.eventCounts.set(type, (this.metrics.eventCounts.get(type) || 0) + 1)
    this.metrics.totalEvents++
    this.metrics.lastEventTime = Date.now()

    if (this.config.verbose) {
      log.debug('SSE event recorded', {
        ...this.config.context,
        type,
        count: this.metrics.eventCounts.get(type)
      })
    }
  }

  /**
   * Record a parse error
   * Tracks error details for debugging and alerting
   */
  recordParseError(error: Error, data: string): void {
    this.metrics.parseErrors++
    this.metrics.hasErrors = true

    // Only store details up to the configured limit to prevent memory issues
    if (this.metrics.parseErrorDetails.length < this.config.maxParseErrorDetails) {
      this.metrics.parseErrorDetails.push({
        error,
        dataSample: data.substring(0, 200), // Limit sample size
        timestamp: Date.now()
      })
    }

    log.error('SSE parse error', {
      ...this.config.context,
      error: error.message,
      dataSample: data.substring(0, 100),
      totalParseErrors: this.metrics.parseErrors
    })
  }

  /**
   * Record an unknown event type
   * Helps detect new SDK versions or malformed events
   */
  recordUnknownType(type: string, event?: SSEEvent | Record<string, unknown>): void {
    const existingUnknown = this.unknownTypeMap.get(type)

    if (existingUnknown) {
      // Increment count for existing unknown type
      existingUnknown.count++
    } else {
      // New unknown type
      const fields = event ? Object.keys(event) : []
      const sample = event ? JSON.stringify(event).substring(0, 200) : ''

      const unknownInfo: UnknownEventInfo = {
        type,
        fields,
        sample,
        firstSeen: Date.now(),
        count: 1
      }

      this.unknownTypeMap.set(type, unknownInfo)

      // Only add to array if we haven't hit the limit
      if (this.metrics.unknownTypes.length < this.config.maxUnknownTypes) {
        this.metrics.unknownTypes.push(unknownInfo)
      }

      log.warn('New unknown SSE event type detected', {
        ...this.config.context,
        type,
        fields,
        sample,
        hint: 'This may indicate a new event type from the AI SDK or a malformed event'
      })
    }
  }

  /**
   * CRITICAL: Detect field name mismatches
   *
   * This would have caught the #355 bug immediately where the event had
   * 'textDelta' instead of 'delta', causing silent failures.
   *
   * @param expectedField - The field name we expect to see
   * @param receivedFields - The actual fields present in the event
   * @param eventType - The type of event being validated
   */
  recordFieldMismatch(
    expectedField: string,
    receivedFields: string[],
    eventType: string
  ): void {
    if (!receivedFields.includes(expectedField)) {
      this.metrics.hasErrors = true

      const mismatch: FieldMismatch = {
        expected: expectedField,
        received: receivedFields,
        eventType,
        timestamp: Date.now()
      }

      this.metrics.fieldMismatches.push(mismatch)

      log.error('⚠️ SSE field mismatch detected', {
        ...this.config.context,
        expected: expectedField,
        received: receivedFields,
        eventType,
        hint: 'This may indicate an AI SDK version mismatch or provider adapter issue',
        suggestedAction: 'Check AI SDK version compatibility and provider adapter implementation'
      })
    }
  }

  /**
   * Validate that an event has expected fields
   * Helper method to make validation easier
   */
  validateEventFields(
    event: SSEEvent | Record<string, unknown>,
    requiredFields: string[]
  ): boolean {
    const eventType = (event as SSEEvent).type || 'unknown'
    const receivedFields = Object.keys(event)
    let isValid = true

    for (const field of requiredFields) {
      if (!receivedFields.includes(field)) {
        this.recordFieldMismatch(field, receivedFields, eventType)
        isValid = false
      }
    }

    return isValid
  }

  /**
   * Start heartbeat monitoring for connection health
   * Detects stalled connections or network issues
   */
  private startHeartbeatMonitoring(): void {
    this.heartbeatCheckInterval = setInterval(() => {
      const timeSinceLastEvent = Date.now() - this.metrics.lastEventTime

      if (timeSinceLastEvent > this.config.heartbeatInterval * 2) {
        // No events for more than 2x heartbeat interval - potential connection issue
        log.warn('SSE connection may be unhealthy', {
          ...this.config.context,
          timeSinceLastEvent,
          lastEventTime: new Date(this.metrics.lastEventTime).toISOString(),
          hint: 'No events received for an extended period'
        })
      }
    }, this.config.heartbeatInterval)
  }

  /**
   * Stop heartbeat monitoring
   * Called automatically on completion
   */
  private stopHeartbeatMonitoring(): void {
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval)
      this.heartbeatCheckInterval = undefined
    }
  }

  /**
   * Complete the monitoring session and generate final report
   * Should be called when the stream ends (successfully or with error)
   *
   * @returns Final metrics for the streaming session
   */
  complete(): SSEMetrics {
    this.metrics.endTime = Date.now()
    this.metrics.completed = true

    // Stop heartbeat monitoring
    this.stopHeartbeatMonitoring()

    const duration = this.metrics.endTime - this.metrics.startTime
    const eventsPerSecond = duration > 0 ? (this.metrics.totalEvents / (duration / 1000)).toFixed(2) : '0'

    // Build event breakdown for logging
    const eventBreakdown: Record<string, number> = {}
    this.metrics.eventCounts.forEach((count, type) => {
      eventBreakdown[type] = count
    })

    log.info('SSE stream completed', {
      ...this.config.context,
      duration: `${duration}ms`,
      totalEvents: this.metrics.totalEvents,
      eventsPerSecond,
      eventBreakdown,
      parseErrors: this.metrics.parseErrors,
      unknownTypeCount: this.metrics.unknownTypes.length,
      fieldMismatchCount: this.metrics.fieldMismatches.length,
      hasErrors: this.metrics.hasErrors
    })

    // Critical alerts for field mismatches
    if (this.metrics.fieldMismatches.length > 0) {
      log.error('⚠️ CRITICAL: Field mismatches detected in SSE stream', {
        ...this.config.context,
        count: this.metrics.fieldMismatches.length,
        mismatches: this.metrics.fieldMismatches,
        actionRequired: 'Check AI SDK compatibility and provider adapter implementation'
      })
    }

    // Warning for unknown event types
    if (this.metrics.unknownTypes.length > 0) {
      log.warn('Unknown SSE event types encountered', {
        ...this.config.context,
        count: this.metrics.unknownTypes.length,
        types: this.metrics.unknownTypes.map(u => ({ type: u.type, count: u.count })),
        hint: 'This may indicate new SDK features or malformed events'
      })
    }

    // Error summary
    if (this.metrics.parseErrors > 0) {
      log.error('SSE parse errors occurred during stream', {
        ...this.config.context,
        count: this.metrics.parseErrors,
        samples: this.metrics.parseErrorDetails.slice(0, 3) // Show first 3 errors
      })
    }

    return this.metrics
  }

  /**
   * Get current metrics snapshot without completing the session
   * Useful for progress reporting or debugging
   */
  getMetrics(): SSEMetrics {
    return { ...this.metrics }
  }

  /**
   * Reset metrics for reuse (not recommended, create new instance instead)
   */
  reset(): void {
    this.stopHeartbeatMonitoring()

    this.metrics = {
      eventCounts: new Map(),
      parseErrors: 0,
      parseErrorDetails: [],
      unknownTypes: [],
      fieldMismatches: [],
      startTime: Date.now(),
      lastEventTime: Date.now(),
      totalEvents: 0,
      completed: false,
      hasErrors: false
    }

    this.unknownTypeMap.clear()
    this.startHeartbeatMonitoring()

    if (this.config.verbose) {
      log.info('SSE monitoring reset', {
        ...this.config.context
      })
    }
  }
}

/**
 * Helper function to create a monitor with common configuration
 */
export function createSSEMonitor(context?: Record<string, unknown>): SSEMonitor {
  return new SSEMonitor({
    verbose: process.env.NODE_ENV === 'development',
    context
  })
}
