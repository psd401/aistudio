import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as events from "aws-cdk-lib/aws-events"
import * as targets from "aws-cdk-lib/aws-events-targets"
import * as iam from "aws-cdk-lib/aws-iam"
import * as logs from "aws-cdk-lib/aws-logs"
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch"
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions"
import * as sns from "aws-cdk-lib/aws-sns"
import { Construct } from "constructs"
import { IEnvironmentConfig } from "../config/environment-config"
import * as path from "path"

/**
 * Configuration for the Compliance Auditor
 */
export interface ComplianceAuditorProps {
  /**
   * Environment configuration
   */
  readonly config: IEnvironmentConfig

  /**
   * Deployment environment
   */
  readonly deploymentEnvironment: string

  /**
   * Project name for prefixing
   * @default "AIStudio"
   */
  readonly projectName?: string

  /**
   * SNS topic for alerts
   * If not provided, alerts are logged only
   */
  readonly alertTopic?: sns.ITopic

  /**
   * Compliance check schedule
   * @default Daily at midnight
   */
  readonly schedule?: events.Schedule

  /**
   * Maximum age for secrets before alerting (in days)
   * @default 90
   */
  readonly maxSecretAge?: number
}

/**
 * Compliance Auditor for Secrets Manager
 *
 * Monitors secrets for compliance violations and generates reports:
 * - Secrets without rotation enabled
 * - Secrets exceeding maximum age
 * - Unencrypted secrets
 * - Secrets missing required tags
 * - Failed rotation attempts
 * - Unused secrets (no recent access)
 *
 * Features:
 * - Automated daily compliance scans
 * - CloudWatch dashboard for visualization
 * - SNS alerts for critical violations
 * - Detailed audit logs in CloudWatch
 * - Custom compliance rules
 *
 * @example
 * ```typescript
 * new ComplianceAuditor(this, 'SecretCompliance', {
 *   config: environmentConfig,
 *   deploymentEnvironment: 'prod',
 *   alertTopic: alertTopic,
 *   maxSecretAge: 60
 * })
 * ```
 */
export class ComplianceAuditor extends Construct {
  public readonly auditorFunction: lambda.Function
  private readonly projectName: string

  constructor(scope: Construct, id: string, props: ComplianceAuditorProps) {
    super(scope, id)

    this.projectName = props.projectName || "AIStudio"

    // Create the auditor Lambda function
    this.auditorFunction = this.createAuditorFunction(props)

    // Create EventBridge rule for scheduled scans
    this.createScheduledScan(props)

    // Create EventBridge rule for rotation events
    this.createRotationMonitor(props)

    // Create compliance metrics
    this.createMetrics(props)
  }

  /**
   * Creates the compliance auditor Lambda function
   */
  private createAuditorFunction(props: ComplianceAuditorProps): lambda.Function {
    const functionName = `${this.projectName}-${props.deploymentEnvironment}-secret-compliance-auditor`

    // Create explicit role to avoid CDK's deprecated fromAwsManagedPolicyName
    const auditorRole = new iam.Role(this, "AuditorRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "AuditorLambdaBasicExecPolicy",
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    })

    const auditorFunction = new lambda.Function(this, "AuditorFunction", {
      functionName,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../../../lambdas/compliance-auditor")),
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      architecture: lambda.Architecture.ARM_64,
      role: auditorRole,
      logGroup: new logs.LogGroup(this, "AuditorLogGroup", {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: props.config.monitoring.logRetention,
        removalPolicy:
          props.deploymentEnvironment === "prod"
            ? cdk.RemovalPolicy.RETAIN
            : cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        PROJECT_NAME: this.projectName,
        ENVIRONMENT: props.deploymentEnvironment,
        MAX_SECRET_AGE: (props.maxSecretAge || 90).toString(),
        ALERT_TOPIC_ARN: props.alertTopic?.topicArn || "",
      },
    })

    // Grant permissions to read secrets metadata
    auditorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:ListSecrets",
          "secretsmanager:DescribeSecret",
          "secretsmanager:ListSecretVersionIds",
        ],
        resources: ["*"],
      })
    )

    // Grant permissions to read CloudTrail for access patterns
    auditorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudtrail:LookupEvents"],
        resources: ["*"],
      })
    )

    // Grant permission to publish CloudWatch metrics
    auditorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "cloudwatch:namespace": `${this.projectName}/SecretsCompliance`,
          },
        },
      })
    )

    // Grant SNS publish if topic provided
    if (props.alertTopic) {
      props.alertTopic.grantPublish(auditorFunction)
    }

    return auditorFunction
  }

  /**
   * Creates EventBridge rule for scheduled compliance scans
   */
  private createScheduledScan(props: ComplianceAuditorProps): void {
    const schedule = props.schedule || events.Schedule.cron({ hour: "0", minute: "0" })

    const rule = new events.Rule(this, "ComplianceScanRule", {
      schedule,
      description: "Daily secrets compliance audit",
      enabled: true,
    })

    rule.addTarget(
      new targets.LambdaFunction(this.auditorFunction, {
        event: events.RuleTargetInput.fromObject({
          scanType: "scheduled",
          timestamp: events.EventField.time,
        }),
      })
    )
  }

  /**
   * Creates EventBridge rule to monitor rotation events
   */
  private createRotationMonitor(props: ComplianceAuditorProps): void {
    const rule = new events.Rule(this, "RotationMonitorRule", {
      eventPattern: {
        source: ["aws.secretsmanager"],
        detailType: ["AWS API Call via CloudTrail"],
        detail: {
          eventName: [
            "RotateSecret",
            "PutSecretValue",
            "CreateSecret",
            "DeleteSecret",
            "UpdateSecret",
          ],
        },
      },
      description: "Monitor Secrets Manager rotation events",
      enabled: true,
    })

    rule.addTarget(
      new targets.LambdaFunction(this.auditorFunction, {
        event: events.RuleTargetInput.fromObject({
          scanType: "rotation-event",
          detail: events.EventField.fromPath("$.detail"),
        }),
      })
    )
  }


  /**
   * Creates CloudWatch alarms for critical compliance violations
   */
  private createMetrics(props: ComplianceAuditorProps): void {
    if (!props.config.monitoring.alarmingEnabled) {
      return
    }

    const namespace = `${this.projectName}/SecretsCompliance`

    // Alarm for rotation failures
    const rotationFailureAlarm = new cloudwatch.Alarm(this, "RotationFailureAlarm", {
      metric: new cloudwatch.Metric({
        namespace,
        metricName: "RotationFailures",
        statistic: "Sum",
        period: cdk.Duration.hours(24),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: "Alert when secret rotation fails",
      alarmName: `${this.projectName}-${props.deploymentEnvironment}-secret-rotation-failure`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })

    // Alarm for secrets without rotation
    const noRotationAlarm = new cloudwatch.Alarm(this, "NoRotationAlarm", {
      metric: new cloudwatch.Metric({
        namespace,
        metricName: "SecretsWithoutRotation",
        statistic: "Average",
      }),
      threshold: 5, // Alert if more than 5 secrets lack rotation
      evaluationPeriods: 1,
      alarmDescription: "Alert when too many secrets lack rotation",
      alarmName: `${this.projectName}-${props.deploymentEnvironment}-secrets-without-rotation`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })

    // Add SNS action if topic provided
    if (props.alertTopic) {
      const snsAction = new cloudwatch_actions.SnsAction(props.alertTopic)
      rotationFailureAlarm.addAlarmAction(snsAction)
      noRotationAlarm.addAlarmAction(snsAction)
    }
  }
}
