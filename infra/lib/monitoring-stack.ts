import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import {
  ADOTInstrumentation,
  IntelligentAlerting,
  ObservabilityDashboards,
} from './constructs/observability';
import { SSEStreamingMonitoring } from './constructs/sse-streaming-monitoring';

import { ConsolidatedMetrics } from './constructs/observability/metrics-types';
import { AuroraCostDashboard } from './constructs/database/aurora-cost-dashboard';

export interface MonitoringStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
  alertEmail?: string;
  pagerDutyKey?: string;
  slackWebhook?: string;
  // Metrics from other stacks for consolidated dashboards
  auroraCostDashboard?: AuroraCostDashboard;
}

/**
 * Enhanced Monitoring Stack with ADOT Integration
 *
 * Provides comprehensive observability through:
 * - AWS Distro for OpenTelemetry (ADOT) for unified telemetry collection
 * - Distributed tracing via AWS X-Ray
 * - Custom metrics and dashboards via CloudWatch
 * - Intelligent alerting with anomaly detection
 * - Automated incident response
 *
 * @see https://github.com/psd401/aistudio.psd401.ai/issues/380
 */
export class MonitoringStack extends cdk.Stack {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly alarmTopic: sns.Topic;
  public readonly adotInstrumentation: ADOTInstrumentation;
  public readonly intelligentAlerting: IntelligentAlerting;
  public readonly observabilityDashboards: ObservabilityDashboards;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const { environment, alertEmail, pagerDutyKey, slackWebhook, auroraCostDashboard } = props;

    // ============================================================================
    // SNS Topic for Alarms
    // ============================================================================
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `aistudio-${environment}-monitoring-alarms`,
      displayName: `AI Studio ${environment.toUpperCase()} Monitoring Alarms`,
    });

    // Add email subscription if provided
    if (alertEmail) {
      this.alarmTopic.addSubscription(new sns_subscriptions.EmailSubscription(alertEmail));
    }

    // ============================================================================
    // ADOT Instrumentation
    // ============================================================================
    this.adotInstrumentation = new ADOTInstrumentation(this, 'ADOTInstrumentation', {
      environment,
      version: '1.0.0',
    });

    // ============================================================================
    // Intelligent Alerting System
    // ============================================================================
    this.intelligentAlerting = new IntelligentAlerting(this, 'IntelligentAlerting', {
      environment,
      serviceName: 'aistudio',
      alarmTopic: this.alarmTopic,
      pagerDutyKey,
      slackWebhook,
    });

    // ============================================================================
    // Observability Dashboards
    // ============================================================================
    // Build consolidated metrics from all infrastructure stacks
    const consolidatedMetrics: ConsolidatedMetrics = {};

    // Add Aurora database metrics if available
    if (auroraCostDashboard?.metrics) {
      consolidatedMetrics.aurora = auroraCostDashboard.metrics;
    }

    // Add cost metrics if available
    if (auroraCostDashboard?.estimatedMonthlyCost) {
      consolidatedMetrics.cost = {
        auroraCost: auroraCostDashboard.estimatedMonthlyCost,
      };
    }

    // Add comprehensive Lambda metrics for ALL processing functions
    // Using search expressions to match function names with CDK-generated suffixes
    consolidatedMetrics.lambda = {
      'file-processor': {
        invocations: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Invocations" FunctionName="AIStudio-ProcessingStack-Dev-FileProcessor*"\', \'Sum\', 300)',
          label: 'File Processor Invocations',
          usingMetrics: {},
        }),
        errors: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Errors" FunctionName="AIStudio-ProcessingStack-Dev-FileProcessor*"\', \'Sum\', 300)',
          label: 'File Processor Errors',
          usingMetrics: {},
        }),
        duration: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Duration" FunctionName="AIStudio-ProcessingStack-Dev-FileProcessor*"\', \'Average\', 300)',
          label: 'File Processor Duration',
          usingMetrics: {},
        }),
        throttles: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Throttles" FunctionName="AIStudio-ProcessingStack-Dev-FileProcessor*"\', \'Sum\', 300)',
          label: 'File Processor Throttles',
          usingMetrics: {},
        }),
        concurrentExecutions: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="ConcurrentExecutions" FunctionName="AIStudio-ProcessingStack-Dev-FileProcessor*"\', \'Maximum\', 300)',
          label: 'File Processor Concurrent Executions',
          usingMetrics: {},
        }),
      },
      'url-processor': {
        invocations: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Invocations" FunctionName="AIStudio-ProcessingStack-Dev-URLProcessor*"\', \'Sum\', 300)',
          label: 'URL Processor Invocations',
          usingMetrics: {},
        }),
        errors: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Errors" FunctionName="AIStudio-ProcessingStack-Dev-URLProcessor*"\', \'Sum\', 300)',
          label: 'URL Processor Errors',
          usingMetrics: {},
        }),
        duration: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Duration" FunctionName="AIStudio-ProcessingStack-Dev-URLProcessor*"\', \'Average\', 300)',
          label: 'URL Processor Duration',
          usingMetrics: {},
        }),
        throttles: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Throttles" FunctionName="AIStudio-ProcessingStack-Dev-URLProcessor*"\', \'Sum\', 300)',
          label: 'URL Processor Throttles',
          usingMetrics: {},
        }),
        concurrentExecutions: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="ConcurrentExecutions" FunctionName="AIStudio-ProcessingStack-Dev-URLProcessor*"\', \'Maximum\', 300)',
          label: 'URL Processor Concurrent Executions',
          usingMetrics: {},
        }),
      },
      'embedding-generator': {
        invocations: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Invocations" FunctionName="AIStudio-ProcessingStack--EmbeddingGenerator*"\', \'Sum\', 300)',
          label: 'Embedding Generator Invocations',
          usingMetrics: {},
        }),
        errors: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Errors" FunctionName="AIStudio-ProcessingStack--EmbeddingGenerator*"\', \'Sum\', 300)',
          label: 'Embedding Generator Errors',
          usingMetrics: {},
        }),
        duration: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Duration" FunctionName="AIStudio-ProcessingStack--EmbeddingGenerator*"\', \'Average\', 300)',
          label: 'Embedding Generator Duration',
          usingMetrics: {},
        }),
        throttles: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Throttles" FunctionName="AIStudio-ProcessingStack--EmbeddingGenerator*"\', \'Sum\', 300)',
          label: 'Embedding Generator Throttles',
          usingMetrics: {},
        }),
        concurrentExecutions: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="ConcurrentExecutions" FunctionName="AIStudio-ProcessingStack--EmbeddingGenerator*"\', \'Maximum\', 300)',
          label: 'Embedding Generator Concurrent Executions',
          usingMetrics: {},
        }),
      },
      'textract-processor': {
        invocations: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Invocations" FunctionName="AIStudio-ProcessingStack--TextractProcessor*"\', \'Sum\', 300)',
          label: 'Textract Processor Invocations',
          usingMetrics: {},
        }),
        errors: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Errors" FunctionName="AIStudio-ProcessingStack--TextractProcessor*"\', \'Sum\', 300)',
          label: 'Textract Processor Errors',
          usingMetrics: {},
        }),
        duration: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Duration" FunctionName="AIStudio-ProcessingStack--TextractProcessor*"\', \'Average\', 300)',
          label: 'Textract Processor Duration',
          usingMetrics: {},
        }),
        throttles: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="Throttles" FunctionName="AIStudio-ProcessingStack--TextractProcessor*"\', \'Sum\', 300)',
          label: 'Textract Processor Throttles',
          usingMetrics: {},
        }),
        concurrentExecutions: new cloudwatch.MathExpression({
          expression: 'SEARCH(\'{AWS/Lambda,FunctionName} MetricName="ConcurrentExecutions" FunctionName="AIStudio-ProcessingStack--TextractProcessor*"\', \'Maximum\', 300)',
          label: 'Textract Processor Concurrent Executions',
          usingMetrics: {},
        }),
      },
    };

    // Add comprehensive ECS metrics for Next.js frontend service
    consolidatedMetrics.ecs = {
      'nextjs-app': {
        // Basic ECS metrics
        cpuUtilization: new cloudwatch.Metric({
          namespace: 'AWS/ECS',
          metricName: 'CPUUtilization',
          dimensionsMap: {
            ServiceName: `aistudio-${environment}`,
            ClusterName: `aistudio-${environment}`,
          },
          statistic: 'Average',
        }),
        memoryUtilization: new cloudwatch.Metric({
          namespace: 'AWS/ECS',
          metricName: 'MemoryUtilization',
          dimensionsMap: {
            ServiceName: `aistudio-${environment}`,
            ClusterName: `aistudio-${environment}`,
          },
          statistic: 'Average',
        }),
        runningTasks: new cloudwatch.Metric({
          namespace: 'ECS/ContainerInsights',
          metricName: 'RunningTaskCount',
          dimensionsMap: {
            ServiceName: `aistudio-${environment}`,
            ClusterName: `aistudio-${environment}`,
          },
          statistic: 'Average',
        }),
        // Container Insights - Network metrics
        requestCount: new cloudwatch.Metric({
          namespace: 'ECS/ContainerInsights',
          metricName: 'NetworkRxBytes',
          dimensionsMap: {
            ServiceName: `aistudio-${environment}`,
            ClusterName: `aistudio-${environment}`,
          },
          statistic: 'Sum',
        }),
        // Additional ECS metrics
        targetResponse: new cloudwatch.Metric({
          namespace: 'ECS/ContainerInsights',
          metricName: 'DesiredTaskCount',
          dimensionsMap: {
            ServiceName: `aistudio-${environment}`,
            ClusterName: `aistudio-${environment}`,
          },
          statistic: 'Average',
        }),
      },
    };

    // Add comprehensive ALB metrics for Next.js frontend
    // Note: We'll use search expressions to find the ALB dynamically
    consolidatedMetrics.network = {
      // ALB request metrics
      bytesIn: new cloudwatch.MathExpression({
        expression: 'SEARCH(\'{AWS/ApplicationELB,LoadBalancer} MetricName="ProcessedBytes" LoadBalancer="*aistudio*"\', \'Sum\', 300)',
        label: 'ALB Bytes Processed',
        usingMetrics: {},
      }),
      bytesOut: new cloudwatch.MathExpression({
        expression: 'SEARCH(\'{AWS/ApplicationELB,LoadBalancer} MetricName="ActiveConnectionCount" LoadBalancer="*aistudio*"\', \'Sum\', 300)',
        label: 'ALB Active Connections',
        usingMetrics: {},
      }),
    };

    // Add comprehensive S3 storage metrics with request metrics
    consolidatedMetrics.storage = {
      'documents-bucket': {
        bucketSize: new cloudwatch.Metric({
          namespace: 'AWS/S3',
          metricName: 'BucketSizeBytes',
          dimensionsMap: {
            BucketName: `aistudio-storagestack-${environment}-documentsbucket`,
            StorageType: 'StandardStorage',
          },
          statistic: 'Average',
          period: cdk.Duration.days(1), // S3 storage metrics are daily
        }),
        objectCount: new cloudwatch.Metric({
          namespace: 'AWS/S3',
          metricName: 'NumberOfObjects',
          dimensionsMap: {
            BucketName: `aistudio-storagestack-${environment}-documentsbucket`,
            StorageType: 'AllStorageTypes',
          },
          statistic: 'Average',
          period: cdk.Duration.days(1), // S3 storage metrics are daily
        }),
        requestMetrics: {
          getRequests: new cloudwatch.Metric({
            namespace: 'AWS/S3',
            metricName: 'GetRequests',
            dimensionsMap: {
              BucketName: `aistudio-storagestack-${environment}-documentsbucket`,
            },
            statistic: 'Sum',
          }),
          putRequests: new cloudwatch.Metric({
            namespace: 'AWS/S3',
            metricName: 'PutRequests',
            dimensionsMap: {
              BucketName: `aistudio-storagestack-${environment}-documentsbucket`,
            },
            statistic: 'Sum',
          }),
        },
      },
    };

    // Add comprehensive ALB metrics for Next.js frontend
    // Using search expressions to dynamically find the ALB
    consolidatedMetrics.api = {
      // Request metrics
      requestCount: new cloudwatch.MathExpression({
        expression: 'SEARCH(\'{AWS/ApplicationELB,LoadBalancer} MetricName="RequestCount" LoadBalancer="*aistudio*"\', \'Sum\', 300)',
        label: 'Total Requests',
        usingMetrics: {},
      }),

      // Error tracking - 5XX errors from targets (Next.js)
      errorCount: new cloudwatch.MathExpression({
        expression: 'SEARCH(\'{AWS/ApplicationELB,LoadBalancer} MetricName="HTTPCode_Target_5XX_Count" LoadBalancer="*aistudio*"\', \'Sum\', 300)',
        label: '5XX Errors',
        usingMetrics: {},
      }),

      // Response time percentiles
      latencyP50: new cloudwatch.MathExpression({
        expression: 'SEARCH(\'{AWS/ApplicationELB,LoadBalancer} MetricName="TargetResponseTime" LoadBalancer="*aistudio*"\', \'p50\', 300)',
        label: 'p50 Latency',
        usingMetrics: {},
      }),
      latencyP90: new cloudwatch.MathExpression({
        expression: 'SEARCH(\'{AWS/ApplicationELB,LoadBalancer} MetricName="TargetResponseTime" LoadBalancer="*aistudio*"\', \'p90\', 300)',
        label: 'p90 Latency',
        usingMetrics: {},
      }),
      latencyP99: new cloudwatch.MathExpression({
        expression: 'SEARCH(\'{AWS/ApplicationELB,LoadBalancer} MetricName="TargetResponseTime" LoadBalancer="*aistudio*"\', \'p99\', 300)',
        label: 'p99 Latency',
        usingMetrics: {},
      }),

      // Availability/uptime tracking
      availability: new cloudwatch.MathExpression({
        expression: 'SEARCH(\'{AWS/ApplicationELB,TargetGroup,LoadBalancer} MetricName="HealthyHostCount" TargetGroup="*aistudio*"\', \'Average\', 300)',
        label: 'Healthy Targets',
        usingMetrics: {},
      }),
    };

    this.observabilityDashboards = new ObservabilityDashboards(this, 'ObservabilityDashboards', {
      environment,
      consolidatedMetrics,
      featureFlags: {
        enableConsolidatedDashboards: true,
        keepLegacyDashboards: false,
        enableCostDashboard: true,
        enableDeepDiveDashboards: false,
      },
    });

    // Use the service dashboard as the primary dashboard
    this.dashboard = this.observabilityDashboards.serviceDashboard;

    // ============================================================================
    // SSE Streaming Monitoring
    // ============================================================================
    // Add SSE Streaming monitoring (issue #365)
    new SSEStreamingMonitoring(this, 'SSEStreamingMonitoring', {
      environment,
      alarmTopic: this.alarmTopic,
      dashboard: this.dashboard,
    });

    // ============================================================================
    // Additional Alarms
    // ============================================================================
    this.createCriticalAlarms(environment);

    // ============================================================================
    // Outputs
    // ============================================================================
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: 'SNS Topic for monitoring alarms',
      exportName: `${environment}-MonitoringAlarmTopicArn`,
    });

    new cdk.CfnOutput(this, 'ADOTLayerArn', {
      value: this.adotInstrumentation.lambdaLayer.layerVersionArn,
      description: 'ADOT Lambda Layer ARN for instrumentation',
      exportName: `${environment}-ADOTLayerArn`,
    });
  }

  /**
   * Add enhanced monitoring widgets for logs and insights
   */
  private addEnhancedMonitoring(environment: string, logGroupName: string): void {
    // Add section header
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## Application Insights`,
        width: 24,
        height: 1,
      })
    );

    // Recent Errors
    this.dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Recent Errors (Last Hour)',
        logGroupNames: [logGroupName],
        view: cloudwatch.LogQueryVisualizationType.TABLE,
        queryLines: [
          'fields @timestamp, @message, level, error.code as errorCode, requestId',
          'filter level = "error"',
          'sort @timestamp desc',
          'limit 20',
        ],
        width: 12,
        height: 8,
        region: this.region,
      }),

      // Slow Operations
      new cloudwatch.LogQueryWidget({
        title: 'Slow Operations (>1s)',
        logGroupNames: [logGroupName],
        view: cloudwatch.LogQueryVisualizationType.TABLE,
        queryLines: [
          'fields @timestamp, action, duration, requestId',
          'filter ispresent(duration) and duration > 1000',
          'sort duration desc',
          'limit 20',
        ],
        width: 12,
        height: 8,
        region: this.region,
      })
    );

    // User Activity
    this.dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Top Active Users',
        logGroupNames: [logGroupName],
        view: cloudwatch.LogQueryVisualizationType.TABLE,
        queryLines: [
          'fields userId, userEmail',
          'filter ispresent(userId)',
          'stats count() as actions by userId, userEmail',
          'sort actions desc',
          'limit 10',
        ],
        width: 12,
        height: 6,
        region: this.region,
      }),

      // Authentication Events
      new cloudwatch.LogQueryWidget({
        title: 'Authentication Events',
        logGroupNames: [logGroupName],
        view: cloudwatch.LogQueryVisualizationType.PIE,
        queryLines: ['fields action', 'filter action like /auth/', 'stats count() by action'],
        width: 12,
        height: 6,
        region: this.region,
      })
    );

    // Insights Queries Reference
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: this.getInsightsQueriesReference(),
        width: 24,
        height: 8,
      })
    );
  }

  /**
   * Create critical system alarms
   */
  private createCriticalAlarms(environment: string): void {
    // Database high utilization alarm
    const dbUtilizationAlarm = new cloudwatch.Alarm(this, 'DatabaseHighUtilization', {
      alarmName: `${environment}-database-high-utilization`,
      alarmDescription: 'Database ACU utilization exceeds 80%',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'ACUUtilization',
        dimensionsMap: {
          DBClusterIdentifier: `aistudio-${environment}`,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Lambda errors alarm
    const lambdaErrorsAlarm = new cloudwatch.Alarm(this, 'LambdaErrors', {
      alarmName: `${environment}-lambda-errors`,
      alarmDescription: 'Lambda function errors detected',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        dimensionsMap: {
          FunctionName: `aistudio-${environment}-file-processor`,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // DLQ messages alarm
    const dlqAlarm = new cloudwatch.Alarm(this, 'DLQMessages', {
      alarmName: `${environment}-dlq-messages`,
      alarmDescription: 'Messages in dead letter queue',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SQS',
        metricName: 'ApproximateNumberOfMessagesVisible',
        dimensionsMap: {
          QueueName: `aistudio-${environment}-file-processing-dlq`,
        },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add alarm actions
    const alarms = [dbUtilizationAlarm, lambdaErrorsAlarm, dlqAlarm];
    alarms.forEach((alarm) => {
      alarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));
    });

    // Add alarm status widget to dashboard
    this.dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Critical Alarm Status',
        alarms,
        width: 24,
        height: 3,
        sortBy: cloudwatch.AlarmStatusWidgetSortBy.STATE_UPDATED_TIMESTAMP,
      })
    );
  }

  /**
   * Get CloudWatch Insights queries reference markdown
   */
  private getInsightsQueriesReference(): string {
    return `## Useful CloudWatch Insights Queries

### Find all logs for a specific request
\`\`\`
fields @timestamp, level, message, requestId, error.code
| filter requestId = "YOUR_REQUEST_ID"
| sort @timestamp desc
\`\`\`

### Top error codes in last hour
\`\`\`
fields error.code
| filter level = "error" and ispresent(error.code)
| stats count() by error.code
| sort count() desc
\`\`\`

### Slow database queries
\`\`\`
fields @timestamp, duration, action, query
| filter duration > 1000 and action like /DB/
| sort duration desc
| limit 50
\`\`\`

### User activity audit
\`\`\`
fields @timestamp, userId, action, message
| filter userId = "USER_ID"
| sort @timestamp desc
| limit 100
\`\`\`

### Failed authentication attempts
\`\`\`
fields @timestamp, message, error.code, userId
| filter error.code like /AUTH_/
| sort @timestamp desc
| limit 50
\`\`\`

### X-Ray Trace Analysis
\`\`\`
fields @timestamp, xrayTraceId, @message
| filter ispresent(xrayTraceId)
| sort @timestamp desc
| limit 100
\`\`\`

[Open CloudWatch Insights](https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#logsV2:logs-insights)
[Open X-Ray Service Map](https://console.aws.amazon.com/xray/home?region=${this.region}#/service-map)
`;
  }
}
