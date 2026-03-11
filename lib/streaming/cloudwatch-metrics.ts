/**
 * CloudWatch Metrics Integration for SSE Streaming
 *
 * Publishes streaming metrics to AWS CloudWatch for monitoring and alerting.
 * This enables production visibility into SSE streaming health and early detection
 * of issues like field mismatches, parse errors, and unknown event types.
 *
 * **Installation Required:**
 * ```bash
 * npm install @aws-sdk/client-cloudwatch
 * ```
 *
 * **IAM Permissions Required:**
 * ```json
 * {
 *   "Version": "2012-10-17",
 *   "Statement": [
 *     {
 *       "Effect": "Allow",
 *       "Action": [
 *         "cloudwatch:PutMetricData"
 *       ],
 *       "Resource": "*"
 *     }
 *   ]
 * }
 * ```
 *
 * @see https://github.com/psd401/aistudio.psd401.ai/issues/365
 */

import { createLogger } from '@/lib/client-logger'
import type { SSEMetrics } from './sse-monitoring'

const log = createLogger({ moduleName: 'cloudwatch-metrics' })

/**
 * CloudWatch namespace for SSE streaming metrics
 */
const METRICS_NAMESPACE = 'AIStudio/Streaming'

/**
 * Environment detection
 */
const ENVIRONMENT = process.env.ENVIRONMENT || process.env.NODE_ENV || 'development'
const AWS_REGION = process.env.AWS_REGION || 'us-west-2'

/**
 * Whether CloudWatch publishing is enabled
 * Only enable in production/staging by default
 */
const CLOUDWATCH_ENABLED = process.env.CLOUDWATCH_METRICS_ENABLED === 'true' ||
  (ENVIRONMENT !== 'development' && ENVIRONMENT !== 'test')

/**
 * SSE Streaming Metrics for CloudWatch
 */
export interface SSEStreamingMetrics {
  /** Number of unknown event types encountered */
  unknownEventCount: number
  /** Number of parse errors */
  parseErrorCount: number
  /** Number of field mismatches (critical indicator) */
  fieldMismatchCount: number
  /** Total events processed */
  totalEvents: number
  /** Stream duration in milliseconds */
  duration: number
  /** Events per second */
  eventsPerSecond: number
  /** Execution ID for correlation */
  executionId?: number
  /** Tool ID for Assistant Architect */
  toolId?: number
  /** Whether stream completed successfully */
  completed: boolean
}

/**
 * Publish SSE streaming metrics to CloudWatch
 *
 * This function is designed to gracefully degrade if CloudWatch SDK is not available
 * or if publishing fails. Metrics publishing should never break the application flow.
 *
 * @param metrics - The metrics to publish
 * @returns Promise that resolves when metrics are published (or immediately if disabled)
 *
 * @example
 * ```typescript
 * const monitor = new SSEMonitor()
 * // ... process stream ...
 * const sseMetrics = monitor.complete()
 *
 * await publishSSEMetrics({
 *   unknownEventCount: sseMetrics.unknownTypes.length,
 *   parseErrorCount: sseMetrics.parseErrors,
 *   fieldMismatchCount: sseMetrics.fieldMismatches.length,
 *   totalEvents: sseMetrics.totalEvents,
 *   duration: (sseMetrics.endTime || Date.now()) - sseMetrics.startTime,
 *   eventsPerSecond: calculateEventsPerSecond(sseMetrics),
 *   executionId: 123,
 *   completed: sseMetrics.completed
 * })
 * ```
 */
export async function publishSSEMetrics(metrics: SSEStreamingMetrics): Promise<void> {
  if (!CLOUDWATCH_ENABLED) {
    log.debug('CloudWatch metrics disabled, skipping publish', {
      environment: ENVIRONMENT
    })
    return
  }

  try {
    // Lazy-load CloudWatch SDK to avoid import errors if not installed
    const { CloudWatchClient, PutMetricDataCommand } = await import('@aws-sdk/client-cloudwatch')

    const client = new CloudWatchClient({
      region: AWS_REGION
    })

    const timestamp = new Date()

    // Build metric data array
    const metricData = []

    // Critical metric: Field mismatches (should always be 0 in healthy system)
    metricData.push({
      MetricName: 'SSEFieldMismatches',
      Value: metrics.fieldMismatchCount,
      Unit: 'Count' as const,
      Timestamp: timestamp,
      Dimensions: [
        { Name: 'Environment', Value: ENVIRONMENT },
        ...(metrics.toolId ? [{ Name: 'ToolId', Value: String(metrics.toolId) }] : [])
      ]
    })

    // Unknown event types (forward compatibility indicator)
    metricData.push({
      MetricName: 'SSEUnknownEvents',
      Value: metrics.unknownEventCount,
      Unit: 'Count' as const,
      Timestamp: timestamp,
      Dimensions: [
        { Name: 'Environment', Value: ENVIRONMENT }
      ]
    })

    // Parse errors (data quality indicator)
    metricData.push({
      MetricName: 'SSEParseErrors',
      Value: metrics.parseErrorCount,
      Unit: 'Count' as const,
      Timestamp: timestamp,
      Dimensions: [
        { Name: 'Environment', Value: ENVIRONMENT }
      ]
    })

    // Total events processed (volume metric)
    metricData.push({
      MetricName: 'SSETotalEvents',
      Value: metrics.totalEvents,
      Unit: 'Count' as const,
      Timestamp: timestamp,
      Dimensions: [
        { Name: 'Environment', Value: ENVIRONMENT }
      ]
    })

    // Stream duration (performance metric)
    metricData.push({
      MetricName: 'SSEStreamDuration',
      Value: metrics.duration,
      Unit: 'Milliseconds' as const,
      Timestamp: timestamp,
      Dimensions: [
        { Name: 'Environment', Value: ENVIRONMENT }
      ]
    })

    // Events per second (throughput metric)
    metricData.push({
      MetricName: 'SSEEventsPerSecond',
      Value: metrics.eventsPerSecond,
      Unit: 'Count/Second' as const,
      Timestamp: timestamp,
      Dimensions: [
        { Name: 'Environment', Value: ENVIRONMENT }
      ]
    })

    // Stream completion status (reliability metric)
    metricData.push({
      MetricName: 'SSEStreamCompleted',
      Value: metrics.completed ? 1 : 0,
      Unit: 'Count' as const,
      Timestamp: timestamp,
      Dimensions: [
        { Name: 'Environment', Value: ENVIRONMENT }
      ]
    })

    // Publish metrics to CloudWatch
    const command = new PutMetricDataCommand({
      Namespace: METRICS_NAMESPACE,
      MetricData: metricData
    })

    await client.send(command)

    log.info('SSE metrics published to CloudWatch', {
      namespace: METRICS_NAMESPACE,
      metricCount: metricData.length,
      executionId: metrics.executionId
    })

  } catch (error) {
    // Log the error but don't throw - metrics publishing should never break the application
    log.warn('Failed to publish SSE metrics to CloudWatch', {
      error: error instanceof Error ? error.message : String(error),
      hint: 'Ensure @aws-sdk/client-cloudwatch is installed and IAM permissions are configured'
    })
  }
}

/**
 * Convert SSEMetrics from monitor to CloudWatch metrics format
 *
 * @param sseMetrics - Metrics from SSEMonitor
 * @param context - Additional context (executionId, toolId, etc.)
 * @returns Metrics in CloudWatch format
 */
export function convertSSEMetricsToCloudWatch(
  sseMetrics: SSEMetrics,
  context?: { executionId?: number; toolId?: number }
): SSEStreamingMetrics {
  const duration = (sseMetrics.endTime || Date.now()) - sseMetrics.startTime
  const eventsPerSecond = duration > 0
    ? Number((sseMetrics.totalEvents / (duration / 1000)).toFixed(2))
    : 0

  return {
    unknownEventCount: sseMetrics.unknownTypes.length,
    parseErrorCount: sseMetrics.parseErrors,
    fieldMismatchCount: sseMetrics.fieldMismatches.length,
    totalEvents: sseMetrics.totalEvents,
    duration,
    eventsPerSecond,
    executionId: context?.executionId,
    toolId: context?.toolId,
    completed: sseMetrics.completed
  }
}

/**
 * Publish metrics from SSEMonitor directly
 *
 * Convenience function that handles conversion and publishing
 *
 * @param sseMetrics - Metrics from SSEMonitor.complete()
 * @param context - Additional context
 * @deprecated No active callers. Tracked for removal in issue #842.
 */
export async function publishSSEMonitorMetrics(
  sseMetrics: SSEMetrics,
  context?: { executionId?: number; toolId?: number }
): Promise<void> {
  const cloudWatchMetrics = convertSSEMetricsToCloudWatch(sseMetrics, context)
  await publishSSEMetrics(cloudWatchMetrics)
}

/**
 * Batch publish metrics for multiple streams
 *
 * Useful for scenarios where multiple streams complete simultaneously
 * and you want to optimize CloudWatch API calls
 *
 * @param metricsArray - Array of metrics to publish
 */
export async function batchPublishSSEMetrics(metricsArray: SSEStreamingMetrics[]): Promise<void> {
  if (!CLOUDWATCH_ENABLED || metricsArray.length === 0) {
    return
  }

  try {
    const { CloudWatchClient, PutMetricDataCommand } = await import('@aws-sdk/client-cloudwatch')

    const client = new CloudWatchClient({
      region: AWS_REGION
    })

    // CloudWatch allows up to 1000 metrics per request
    const BATCH_SIZE = 1000
    const timestamp = new Date()

    for (let i = 0; i < metricsArray.length; i += BATCH_SIZE) {
      const batch = metricsArray.slice(i, i + BATCH_SIZE)
      const metricData = batch.flatMap(metrics => [
        {
          MetricName: 'SSEFieldMismatches',
          Value: metrics.fieldMismatchCount,
          Unit: 'Count' as const,
          Timestamp: timestamp,
          Dimensions: [
            { Name: 'Environment', Value: ENVIRONMENT },
            ...(metrics.executionId ? [{ Name: 'ExecutionId', Value: String(metrics.executionId) }] : [])
          ]
        },
        {
          MetricName: 'SSEUnknownEvents',
          Value: metrics.unknownEventCount,
          Unit: 'Count' as const,
          Timestamp: timestamp,
          Dimensions: [{ Name: 'Environment', Value: ENVIRONMENT }]
        },
        {
          MetricName: 'SSEParseErrors',
          Value: metrics.parseErrorCount,
          Unit: 'Count' as const,
          Timestamp: timestamp,
          Dimensions: [{ Name: 'Environment', Value: ENVIRONMENT }]
        }
      ])

      const command = new PutMetricDataCommand({
        Namespace: METRICS_NAMESPACE,
        MetricData: metricData
      })

      await client.send(command)
    }

    log.info('Batch SSE metrics published to CloudWatch', {
      namespace: METRICS_NAMESPACE,
      batchCount: metricsArray.length
    })

  } catch (error) {
    log.warn('Failed to batch publish SSE metrics to CloudWatch', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
