import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { ServiceRoleFactory } from '../security';

export interface IntelligentAlertingProps {
  environment: 'dev' | 'prod';
  serviceName: string;
  alarmTopic: sns.ITopic;
  pagerDutyKey?: string;
  slackWebhook?: string;
}

/**
 * Intelligent Alerting System
 * Provides anomaly detection, composite alarms, and intelligent routing
 */
export class IntelligentAlerting extends Construct {
  public readonly anomalyDetectors: Map<string, cloudwatch.CfnAnomalyDetector>;
  public readonly compositeAlarms: Map<string, cloudwatch.CompositeAlarm>;
  private readonly alertRouter: lambda.Function;

  constructor(scope: Construct, id: string, props: IntelligentAlertingProps) {
    super(scope, id);

    const { alarmTopic } = props;

    this.anomalyDetectors = new Map();
    this.compositeAlarms = new Map();

    // Create alert router Lambda
    this.alertRouter = this.createAlertRouter(props);

    // Subscribe router to alarm topic
    alarmTopic.addSubscription(new sns_subscriptions.LambdaSubscription(this.alertRouter));

    // Create composite alarms
    this.createCompositeAlarms(props);

    // Setup anomaly detection
    this.setupAnomalyDetection(props);
  }

  /**
   * Create composite alarm for service health
   */
  private createCompositeAlarms(props: IntelligentAlertingProps): void {
    const { environment, serviceName, alarmTopic } = props;

    // P1: Service Down Composite Alarm
    const highErrorRateAlarm = new cloudwatch.Alarm(this, 'HighErrorRate', {
      alarmName: `${environment}-${serviceName}-high-error-rate`,
      alarmDescription: 'Error rate exceeds 10% for 2 evaluation periods',
      metric: new cloudwatch.Metric({
        namespace: `AIStudio/${environment}`,
        metricName: 'error_rate',
        dimensionsMap: { service: serviceName },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const highLatencyAlarm = new cloudwatch.Alarm(this, 'HighLatency', {
      alarmName: `${environment}-${serviceName}-high-latency`,
      alarmDescription: 'P99 latency exceeds 5 seconds',
      metric: new cloudwatch.Metric({
        namespace: `AIStudio/${environment}`,
        metricName: 'latency_p99',
        dimensionsMap: { service: serviceName },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5000,
      evaluationPeriods: 2,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Low traffic alarm could be used in future composite alarms
    // const lowTrafficAlarm = new cloudwatch.Alarm(this, 'LowTraffic', {
    //   alarmName: `${environment}-${serviceName}-low-traffic`,
    //   alarmDescription: 'Request count dropped significantly',
    //   metric: new cloudwatch.Metric({
    //     namespace: `AIStudio/${environment}`,
    //     metricName: 'request_count',
    //     dimensionsMap: { service: serviceName },
    //     statistic: 'Sum',
    //     period: cdk.Duration.minutes(5),
    //   }),
    //   threshold: 10,
    //   comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    //   evaluationPeriods: 5,
    //   treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    // });

    const serviceDownAlarm = new cloudwatch.CompositeAlarm(this, 'ServiceDown', {
      compositeAlarmName: `${environment}-${serviceName}-down`,
      alarmDescription: 'Service is experiencing critical issues',
      alarmRule: cloudwatch.AlarmRule.allOf(
        cloudwatch.AlarmRule.fromAlarm(highErrorRateAlarm, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(highLatencyAlarm, cloudwatch.AlarmState.ALARM)
      ),
      actionsEnabled: true,
    });

    serviceDownAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    this.compositeAlarms.set('service-down', serviceDownAlarm);
  }

  /**
   * Setup anomaly detection for key metrics
   */
  private setupAnomalyDetection(props: IntelligentAlertingProps): void {
    const { environment, serviceName, alarmTopic } = props;

    // Lambda cold start anomaly detector
    const coldStartDetector = new cloudwatch.CfnAnomalyDetector(this, 'ColdStartDetector', {
      namespace: 'AWS/Lambda',
      metricName: 'Duration',
      stat: 'Average',
      dimensions: [{ name: 'FunctionName', value: `aistudio-${environment}-*` }],
    });

    // Create alarm for cold start anomalies
    new cloudwatch.CfnAlarm(this, 'ColdStartAnomaly', {
      comparisonOperator: 'LessThanLowerOrGreaterThanUpperThreshold',
      evaluationPeriods: 2,
      metrics: [
        {
          expression: 'ANOMALY_DETECTION_BAND(m1, 2)',
          id: 'ad1',
        },
        {
          id: 'm1',
          metricStat: {
            metric: {
              namespace: 'AWS/Lambda',
              metricName: 'Duration',
              dimensions: [{ name: 'FunctionName', value: `aistudio-${environment}-*` }],
            },
            stat: 'Average',
            period: 300,
          },
          returnData: true,
        },
      ],
      thresholdMetricId: 'ad1',
      actionsEnabled: true,
      alarmActions: [alarmTopic.topicArn],
      alarmDescription: 'Unusual Lambda cold start pattern detected',
      alarmName: `${environment}-${serviceName}-cold-start-anomaly`,
      treatMissingData: 'notBreaching',
    });

    this.anomalyDetectors.set('cold-start', coldStartDetector);

    // Database connection anomaly detector
    const dbConnectionDetector = new cloudwatch.CfnAnomalyDetector(this, 'DBConnectionDetector', {
      namespace: 'AWS/RDS',
      metricName: 'DatabaseConnections',
      stat: 'Average',
      dimensions: [{ name: 'DBClusterIdentifier', value: `aistudio-${environment}` }],
    });

    // Create alarm for DB connection anomalies
    new cloudwatch.CfnAlarm(this, 'DBConnectionAnomaly', {
      comparisonOperator: 'LessThanLowerOrGreaterThanUpperThreshold',
      evaluationPeriods: 2,
      metrics: [
        {
          expression: 'ANOMALY_DETECTION_BAND(m1, 2)',
          id: 'ad1',
        },
        {
          id: 'm1',
          metricStat: {
            metric: {
              namespace: 'AWS/RDS',
              metricName: 'DatabaseConnections',
              dimensions: [{ name: 'DBClusterIdentifier', value: `aistudio-${environment}` }],
            },
            stat: 'Average',
            period: 300,
          },
          returnData: true,
        },
      ],
      thresholdMetricId: 'ad1',
      actionsEnabled: true,
      alarmActions: [alarmTopic.topicArn],
      alarmDescription: 'Unusual database connection pattern detected',
      alarmName: `${environment}-db-connection-anomaly`,
      treatMissingData: 'notBreaching',
    });

    this.anomalyDetectors.set('db-connection', dbConnectionDetector);
  }

  /**
   * Create alert router Lambda function
   */
  private createAlertRouter(props: IntelligentAlertingProps): lambda.Function {
    const { environment, alarmTopic, pagerDutyKey, slackWebhook } = props;

    // Create Lambda role using ServiceRoleFactory
    const routerRole = ServiceRoleFactory.createLambdaRole(this, 'AlertRouterRole', {
      functionName: 'alert-router',
      environment,
      region: cdk.Stack.of(this).region,
      account: cdk.Stack.of(this).account,
      additionalPolicies: [
        // CloudWatch permissions for alarm introspection
        new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['cloudwatch:DescribeAlarms', 'cloudwatch:DescribeAlarmHistory'],
              resources: [
                `arn:aws:cloudwatch:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:alarm:*`,
              ],
            }),
          ],
        }),
      ],
      snsTopics: [{ arn: alarmTopic.topicArn }], // Grant publish permission to SNS topic
    });

    const router = new lambda.Function(this, 'AlertRouter', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      role: routerRole, // Use ServiceRoleFactory-created role
      code: lambda.Code.fromInline(`
import json
import boto3
import os
from datetime import datetime

sns = boto3.client('sns')
cloudwatch = boto3.client('cloudwatch')

def handler(event, context):
    """Route and enrich CloudWatch alarms"""
    try:
        alarm = json.loads(event['Records'][0]['Sns']['Message'])

        # Enrich with context
        enriched = enrich_alarm(alarm)

        # Determine priority
        priority = calculate_priority(enriched)

        # Log enriched alarm
        print(json.dumps({
            'alarm': enriched,
            'priority': priority,
            'timestamp': datetime.utcnow().isoformat()
        }))

        return {'statusCode': 200, 'priority': priority}

    except Exception as e:
        print(f'Error processing alarm: {str(e)}')
        return {'statusCode': 500, 'error': str(e)}

def enrich_alarm(alarm):
    """Add deployment and context info"""
    alarm['enriched_at'] = datetime.utcnow().isoformat()
    alarm['environment'] = '${environment}'

    # Add suggested actions based on alarm type
    alarm_name = alarm.get('AlarmName', '')
    if 'high-error-rate' in alarm_name:
        alarm['suggested_actions'] = [
            'Check recent deployments',
            'Review CloudWatch Logs for errors',
            'Check X-Ray traces for failed requests'
        ]
    elif 'high-latency' in alarm_name:
        alarm['suggested_actions'] = [
            'Check database performance',
            'Review X-Ray service map',
            'Check for resource constraints'
        ]
    elif 'anomaly' in alarm_name:
        alarm['suggested_actions'] = [
            'Compare with baseline metrics',
            'Check for unusual traffic patterns',
            'Review recent configuration changes'
        ]

    return alarm

def calculate_priority(alarm):
    """Determine P1-P4 based on impact"""
    alarm_name = alarm.get('AlarmName', '').lower()

    if 'down' in alarm_name or 'critical' in alarm_name:
        return 'P1'
    elif 'high-error-rate' in alarm_name or 'high-latency' in alarm_name:
        return 'P2'
    elif 'anomaly' in alarm_name:
        return 'P3'
    else:
        return 'P4'
`),
      environment: {
        SNS_TOPIC_ARN: alarmTopic.topicArn,
        PAGERDUTY_KEY: pagerDutyKey || '',
        SLACK_WEBHOOK: slackWebhook || '',
        ENVIRONMENT: environment,
      },
      timeout: cdk.Duration.seconds(30),
      description: 'Routes and enriches CloudWatch alarms with context',
    });

    return router;
  }

  /**
   * Add a custom anomaly detector
   */
  public addAnomalyDetector(
    id: string,
    namespace: string,
    metricName: string,
    dimensions: Array<{ name: string; value: string }>
  ): cloudwatch.CfnAnomalyDetector {
    const detector = new cloudwatch.CfnAnomalyDetector(this, `${id}Detector`, {
      namespace,
      metricName,
      stat: 'Average',
      dimensions,
    });

    this.anomalyDetectors.set(id, detector);
    return detector;
  }
}
