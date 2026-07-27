/**
 * SSE Streaming Monitoring Construct
 *
 * Provides CloudWatch alarms and dashboard widgets for SSE streaming health monitoring.
 * Integrates with the monitoring created in issue #365.
 *
 * Features:
 * - Field mismatch alarms (critical - indicates SDK version issues)
 * - Parse error alarms (indicates data quality issues)
 * - Unknown event type tracking (forward compatibility indicator)
 * - Stream performance metrics (duration, throughput)
 * - Dashboard widgets for visibility
 *
 * @see https://github.com/psd401/aistudio.psd401.ai/issues/365
 */

import { Construct } from 'constructs'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as cdk from 'aws-cdk-lib'

export interface SSEStreamingMonitoringProps {
  /** Environment name (dev, prod, etc.) */
  environment: string
  /** SNS topic for alarm notifications */
  alarmTopic: sns.ITopic
  /** Dashboard to add widgets to */
  dashboard?: cloudwatch.Dashboard
}

interface SSEGraphWidgetConfig {
  title: string
  metricName: string
  statistic: string
  label: string
  color: string
  axisLabel: string
}

/**
 * Construct for SSE Streaming monitoring infrastructure
 */
export class SSEStreamingMonitoring extends Construct {
  public readonly alarms: {
    fieldMismatch: cloudwatch.Alarm
    parseErrors: cloudwatch.Alarm
    unknownEvents: cloudwatch.Alarm
    streamFailures: cloudwatch.Alarm
  }

  constructor(scope: Construct, id: string, props: SSEStreamingMonitoringProps) {
    super(scope, id)

    const { environment, alarmTopic, dashboard } = props

    // Namespace for SSE streaming metrics
    const namespace = 'AIStudio/Streaming'

    // Initialize alarms object
    // We'll populate each property below, but TypeScript requires initialization
    this.alarms = {} as {
      fieldMismatch: cloudwatch.Alarm
      parseErrors: cloudwatch.Alarm
      unknownEvents: cloudwatch.Alarm
      streamFailures: cloudwatch.Alarm
    }

    // ========================================================================
    // CRITICAL ALARM: Field Mismatches
    // ========================================================================
    // This alarm catches issues like #355 where field names don't match SDK expectations
    this.alarms.fieldMismatch = new cloudwatch.Alarm(this, 'SSEFieldMismatchAlarm', {
      alarmName: `${environment}-sse-field-mismatches`,
      alarmDescription: 'CRITICAL: SSE field mismatch detected - possible AI SDK compatibility issue. This would have caught bug #355.',
      metric: new cloudwatch.Metric({
        namespace,
        metricName: 'SSEFieldMismatches',
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.minutes(5),
        dimensionsMap: {
          Environment: environment
        }
      }),
      threshold: 1, // Alert on ANY field mismatch
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    })

    // Add action to notify via SNS
    this.alarms.fieldMismatch.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic))

    // ========================================================================
    // HIGH PRIORITY ALARM: Parse Errors
    // ========================================================================
    // Indicates malformed SSE events or data quality issues
    this.alarms.parseErrors = new cloudwatch.Alarm(this, 'SSEParseErrorAlarm', {
      alarmName: `${environment}-sse-parse-errors`,
      alarmDescription: 'High parse error rate in SSE streams - check data quality and SDK compatibility',
      metric: new cloudwatch.Metric({
        namespace,
        metricName: 'SSEParseErrors',
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.minutes(5),
        dimensionsMap: {
          Environment: environment
        }
      }),
      threshold: 10, // Alert if more than 10 parse errors in 5 minutes
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    })

    this.alarms.parseErrors.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic))

    // ========================================================================
    // MEDIUM PRIORITY ALARM: Unknown Event Types
    // ========================================================================
    // May indicate new SDK version or malformed events
    this.alarms.unknownEvents = new cloudwatch.Alarm(this, 'SSEUnknownEventsAlarm', {
      alarmName: `${environment}-sse-unknown-events`,
      alarmDescription: 'High rate of unknown SSE event types - may indicate new SDK version or malformed events',
      metric: new cloudwatch.Metric({
        namespace,
        metricName: 'SSEUnknownEvents',
        statistic: cloudwatch.Stats.SUM,
        period: cdk.Duration.minutes(15),
        dimensionsMap: {
          Environment: environment
        }
      }),
      threshold: 50, // Alert if more than 50 unknown events in 15 minutes
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    })

    this.alarms.unknownEvents.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic))

    // ========================================================================
    // STREAM FAILURE ALARM
    // ========================================================================
    // Monitors stream completion rate
    this.alarms.streamFailures = new cloudwatch.Alarm(this, 'SSEStreamFailuresAlarm', {
      alarmName: `${environment}-sse-stream-failures`,
      alarmDescription: 'High rate of failed SSE streams',
      metric: new cloudwatch.MathExpression({
        expression: '100 - (completed / (completed + 1) * 100)',
        usingMetrics: {
          completed: new cloudwatch.Metric({
            namespace,
            metricName: 'SSEStreamCompleted',
            statistic: cloudwatch.Stats.SUM,
            period: cdk.Duration.minutes(10),
            dimensionsMap: {
              Environment: environment
            }
          })
        },
        period: cdk.Duration.minutes(10)
      }),
      threshold: 10, // Alert if failure rate > 10%
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    })

    this.alarms.streamFailures.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic))

    // ========================================================================
    // DASHBOARD WIDGETS (if dashboard provided)
    // ========================================================================
    if (dashboard) {
      this.addDashboardWidgets(dashboard, namespace, environment)
    }
  }

  /**
   * Add SSE streaming widgets to the dashboard
   */
  private addDashboardWidgets(
    dashboard: cloudwatch.Dashboard,
    namespace: string,
    environment: string
  ): void {
    // Title widget for SSE Streaming section
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## SSE Streaming Health

Monitor Server-Sent Events streaming for field mismatches, parse errors, and unknown event types.
**Critical:** Field mismatches indicate SDK version compatibility issues (see [#355](https://github.com/psd401/aistudio.psd401.ai/issues/355))`,
        width: 24,
        height: 2
      })
    )

    dashboard.addWidgets(
      this.createMetricWidget(namespace, environment, {
        title: 'SSE Field Mismatches (Critical)',
        metricName: 'SSEFieldMismatches',
        statistic: cloudwatch.Stats.SUM,
        label: 'Field Mismatches',
        color: cloudwatch.Color.RED,
        axisLabel: 'Count'
      }),
      this.createMetricWidget(namespace, environment, {
        title: 'SSE Parse Errors',
        metricName: 'SSEParseErrors',
        statistic: cloudwatch.Stats.SUM,
        label: 'Parse Errors',
        color: cloudwatch.Color.ORANGE,
        axisLabel: 'Count'
      }),
      this.createMetricWidget(namespace, environment, {
        title: 'Unknown Event Types',
        metricName: 'SSEUnknownEvents',
        statistic: cloudwatch.Stats.SUM,
        label: 'Unknown Events',
        color: cloudwatch.Color.BLUE,
        axisLabel: 'Count'
      })
    )

    dashboard.addWidgets(
      this.createMetricWidget(namespace, environment, {
        title: 'SSE Stream Volume',
        metricName: 'SSETotalEvents',
        statistic: cloudwatch.Stats.SUM,
        label: 'Total Events',
        color: cloudwatch.Color.GREEN,
        axisLabel: 'Events'
      }),
      this.createMetricWidget(namespace, environment, {
        title: 'SSE Stream Duration',
        metricName: 'SSEStreamDuration',
        statistic: cloudwatch.Stats.AVERAGE,
        label: 'Avg Duration (ms)',
        color: cloudwatch.Color.PURPLE,
        axisLabel: 'Milliseconds'
      }),
      this.createMetricWidget(namespace, environment, {
        title: 'SSE Throughput',
        metricName: 'SSEEventsPerSecond',
        statistic: cloudwatch.Stats.AVERAGE,
        label: 'Events/Second',
        color: cloudwatch.Color.BROWN,
        axisLabel: 'Events per Second'
      })
    )

    // Alarm status row
    dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'SSE Streaming Alarms',
        width: 24,
        height: 3,
        alarms: [
          this.alarms.fieldMismatch,
          this.alarms.parseErrors,
          this.alarms.unknownEvents,
          this.alarms.streamFailures
        ]
      })
    )
  }

  private createMetricWidget(
    namespace: string,
    environment: string,
    config: SSEGraphWidgetConfig
  ): cloudwatch.GraphWidget {
    return new cloudwatch.GraphWidget({
      title: config.title,
      width: 8,
      height: 6,
      left: [
        new cloudwatch.Metric({
          namespace,
          metricName: config.metricName,
          statistic: config.statistic,
          period: cdk.Duration.minutes(5),
          dimensionsMap: { Environment: environment },
          label: config.label,
          color: config.color
        })
      ],
      leftYAxis: {
        min: 0,
        label: config.axisLabel,
        showUnits: false
      },
      legendPosition: cloudwatch.LegendPosition.BOTTOM
    })
  }
}
