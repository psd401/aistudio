import * as cdk from "aws-cdk-lib"
import * as rds from "aws-cdk-lib/aws-rds"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as events from "aws-cdk-lib/aws-events"
import * as targets from "aws-cdk-lib/aws-events-targets"
import * as iam from "aws-cdk-lib/aws-iam"
import * as logs from "aws-cdk-lib/aws-logs"
import { Construct } from "constructs"
import * as path from "path"

export interface AuroraCostOptimizerProps {
  /**
   * The Aurora cluster to optimize
   */
  cluster: rds.IDatabaseCluster

  /**
   * Environment name (dev, staging, prod)
   */
  environment: "dev" | "staging" | "prod"

  /**
   * Enable auto-pause for idle periods
   * @default true for dev/staging, false for prod
   */
  enableAutoPause?: boolean

  /**
   * Minutes of inactivity before auto-pause
   * @default 30
   */
  idleMinutesBeforePause?: number

  /**
   * Enable scheduled scaling
   * @default false for dev, true for staging/prod
   */
  enableScheduledScaling?: boolean

  /**
   * Business hours configuration for scheduled scaling
   */
  businessHours?: {
    /**
     * Hour to scale up (0-23)
     * @default 7
     */
    scaleUpHour?: number

    /**
     * Hour to scale down (0-23)
     * @default 20
     */
    scaleDownHour?: number

    /**
     * Days of week for business hours (MON-FRI, SAT, SUN)
     * @default "MON-FRI"
     */
    daysOfWeek?: string
  }

  /**
   * Scaling configuration
   */
  scaling?: {
    /**
     * Minimum ACU for business hours
     * @default current minimum
     */
    businessHoursMin?: number

    /**
     * Maximum ACU for business hours
     * @default current maximum
     */
    businessHoursMax?: number

    /**
     * Minimum ACU for off-hours
     * @default 0.5
     */
    offHoursMin?: number

    /**
     * Maximum ACU for off-hours
     * @default current minimum
     */
    offHoursMax?: number
  }
}

/**
 * Construct to optimize Aurora Serverless v2 costs through intelligent
 * auto-pause and scheduled scaling strategies.
 *
 * Features:
 * - Auto-pause during idle periods (dev/staging)
 * - Scheduled scaling based on business hours
 * - CloudWatch metrics integration
 * - Transparent wake-up on connection
 */
export class AuroraCostOptimizer extends Construct {
  public readonly pauseResumeFunction: lambda.Function
  public readonly scalingFunction?: lambda.Function

  constructor(scope: Construct, id: string, props: AuroraCostOptimizerProps) {
    super(scope, id)

    const enableAutoPause =
      props.enableAutoPause ?? (props.environment !== "prod")
    const enableScheduledScaling =
      props.enableScheduledScaling ?? (props.environment !== "dev")

    // Create Lambda function for pause/resume operations
    const pauseResumeFunctionRole = new iam.Role(this, "PauseResumeFunctionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "PauseResumeLambdaBasicExecPolicy",
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    })

    // Scope RDS actions to specific cluster for least privilege
    pauseResumeFunctionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "rds:ModifyDBCluster",
          "rds:DescribeDBClusters",
        ],
        resources: [props.cluster.clusterArn],
      })
    )

    // CloudWatch metrics require wildcard but we scope to RDS namespace
    pauseResumeFunctionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:GetMetricStatistics"],
        resources: ["*"], // Required for CloudWatch metrics API
        conditions: {
          StringEquals: {
            "cloudwatch:namespace": "AWS/RDS"
          }
        }
      })
    )

    // Create log group for pause/resume function
    const pauseResumeLogGroup = new logs.LogGroup(this, "PauseResumeFunctionLogGroup", {
      logGroupName: `/aws/lambda/aistudio-${props.environment}-aurora-pause-resume`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // Add tags for cost tracking and resource management
    cdk.Tags.of(pauseResumeLogGroup).add("Environment", props.environment)
    cdk.Tags.of(pauseResumeLogGroup).add("CostCenter", "Database")
    cdk.Tags.of(pauseResumeLogGroup).add("Component", "AuroraCostOptimizer")
    cdk.Tags.of(pauseResumeLogGroup).add("ManagedBy", "CDK")

    this.pauseResumeFunction = new lambda.Function(this, "PauseResumeFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "pause_resume.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../../lambdas/aurora-cost-optimizer")
      ),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      role: pauseResumeFunctionRole,
      reservedConcurrentExecutions: 1, // Prevent concurrent executions and race conditions
      environment: {
        CLUSTER_IDENTIFIER: props.cluster.clusterIdentifier,
        ENVIRONMENT: props.environment,
        IDLE_MINUTES_THRESHOLD: (
          props.idleMinutesBeforePause ?? 30
        ).toString(),
      },
      logGroup: pauseResumeLogGroup,
      description: `Aurora cost optimizer for ${props.environment} environment`,
    })

    // Set up auto-pause checks if enabled
    if (enableAutoPause) {
      // Check every 15 minutes for idle status
      const autoPauseRule = new events.Rule(this, "AutoPauseCheckSchedule", {
        schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
        description: `Check for idle Aurora cluster to auto-pause (${props.environment})`,
      })

      autoPauseRule.addTarget(
        new targets.LambdaFunction(this.pauseResumeFunction, {
          event: events.RuleTargetInput.fromObject({
            action: "auto",
            reason: "Scheduled idle check",
          }),
        })
      )

      // Add CloudWatch alarm for unexpected pause failures
      const pauseErrorMetric = this.pauseResumeFunction.metricErrors({
        period: cdk.Duration.hours(1),
      })

      pauseErrorMetric.createAlarm(this, "PauseResumeErrorAlarm", {
        threshold: 3,
        evaluationPeriods: 1,
        alarmDescription: `Aurora pause/resume function errors in ${props.environment}`,
        treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
      })
    }

    // Set up scheduled scaling if enabled
    if (enableScheduledScaling) {
      const scalingFunctionRole = new iam.Role(this, "ScalingFunctionRole", {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        managedPolicies: [
          iam.ManagedPolicy.fromManagedPolicyArn(
            this,
            "ScalingLambdaBasicExecPolicy",
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
          ),
        ],
      })

      // Scope RDS actions to specific cluster for least privilege
      scalingFunctionRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["rds:ModifyDBCluster", "rds:DescribeDBClusters"],
          resources: [props.cluster.clusterArn],
        })
      )

      // Create log group for scaling function
      const scalingLogGroup = new logs.LogGroup(this, "ScalingFunctionLogGroup", {
        logGroupName: `/aws/lambda/aistudio-${props.environment}-aurora-scaling`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      })

      // Add tags for cost tracking and resource management
      cdk.Tags.of(scalingLogGroup).add("Environment", props.environment)
      cdk.Tags.of(scalingLogGroup).add("CostCenter", "Database")
      cdk.Tags.of(scalingLogGroup).add("Component", "AuroraCostOptimizer")
      cdk.Tags.of(scalingLogGroup).add("ManagedBy", "CDK")

      this.scalingFunction = new lambda.Function(this, "ScalingFunction", {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: "predictive_scaling.handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../../lambdas/aurora-cost-optimizer")
        ),
        timeout: cdk.Duration.minutes(2),
        memorySize: 256,
        role: scalingFunctionRole,
        reservedConcurrentExecutions: 1, // Prevent concurrent executions and race conditions
        environment: {
          CLUSTER_IDENTIFIER: props.cluster.clusterIdentifier,
          ENVIRONMENT: props.environment,
        },
        logGroup: scalingLogGroup,
        description: `Aurora predictive scaling for ${props.environment} environment`,
      })

      const businessHours = props.businessHours ?? {}
      const scaling = props.scaling ?? {}

      // Scale up for business hours
      const scaleUpRule = new events.Rule(this, "BusinessHoursScaleUp", {
        schedule: events.Schedule.cron({
          hour: (businessHours.scaleUpHour ?? 7).toString(),
          minute: "30",
          weekDay: businessHours.daysOfWeek ?? "MON-FRI",
        }),
        description: `Scale up Aurora for business hours (${props.environment})`,
      })

      scaleUpRule.addTarget(
        new targets.LambdaFunction(this.scalingFunction, {
          event: events.RuleTargetInput.fromObject({
            minCapacity: scaling.businessHoursMin,
            maxCapacity: scaling.businessHoursMax,
            reason: "Business hours scale-up",
          }),
        })
      )

      // Scale down after business hours
      const scaleDownRule = new events.Rule(this, "AfterHoursScaleDown", {
        schedule: events.Schedule.cron({
          hour: (businessHours.scaleDownHour ?? 20).toString(),
          minute: "0",
          weekDay: businessHours.daysOfWeek ?? "MON-FRI",
        }),
        description: `Scale down Aurora after business hours (${props.environment})`,
      })

      scaleDownRule.addTarget(
        new targets.LambdaFunction(this.scalingFunction, {
          event: events.RuleTargetInput.fromObject({
            minCapacity: scaling.offHoursMin ?? 0.5,
            maxCapacity: scaling.offHoursMax,
            reason: "After hours scale-down",
          }),
        })
      )

      // Weekend minimal scaling
      if (props.environment !== "dev") {
        const weekendScaleRule = new events.Rule(this, "WeekendMinimalScale", {
          schedule: events.Schedule.cron({
            hour: "0",
            minute: "0",
            weekDay: "SAT",
          }),
          description: `Minimal weekend scaling for Aurora (${props.environment})`,
        })

        weekendScaleRule.addTarget(
          new targets.LambdaFunction(this.scalingFunction, {
            event: events.RuleTargetInput.fromObject({
              minCapacity: 0.5,
              maxCapacity: scaling.offHoursMax ?? 1,
              reason: "Weekend minimal capacity",
            }),
          })
        )
      }
    }

    // Output configuration summary
    new cdk.CfnOutput(this, "AutoPauseEnabled", {
      value: enableAutoPause.toString(),
      description: `Auto-pause enabled for ${props.environment}`,
    })

    new cdk.CfnOutput(this, "ScheduledScalingEnabled", {
      value: enableScheduledScaling.toString(),
      description: `Scheduled scaling enabled for ${props.environment}`,
    })
  }
}
