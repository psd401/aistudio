import * as cdk from "aws-cdk-lib"
import * as rds from "aws-cdk-lib/aws-rds"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as events from "aws-cdk-lib/aws-events"
import * as targets from "aws-cdk-lib/aws-events-targets"
import * as iam from "aws-cdk-lib/aws-iam"
import * as logs from "aws-cdk-lib/aws-logs"
import { Construct } from "constructs"
import * as path from "node:path"

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
      props.enableAutoPause ?? props.environment !== "prod"
    const enableScheduledScaling =
      props.enableScheduledScaling ?? props.environment !== "dev"

    this.pauseResumeFunction = this.createPauseResumeFunction(props)
    if (enableAutoPause) {
      this.configureAutoPause(props)
    }
    if (enableScheduledScaling) {
      this.scalingFunction = this.createScalingFunction(props)
      this.configureScalingSchedules(props, this.scalingFunction)
    }
    this.createConfigurationOutputs(
      props.environment,
      enableAutoPause,
      enableScheduledScaling
    )
  }

  private createFunctionRole(
    id: string,
    policyId: string,
    clusterArn: string,
    includeCloudWatch: boolean
  ): iam.Role {
    const role = new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          policyId,
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    })
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["rds:ModifyDBCluster", "rds:DescribeDBClusters"],
        resources: [clusterArn],
      })
    )
    if (includeCloudWatch) {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["cloudwatch:GetMetricStatistics"],
          resources: ["*"],
          conditions: {
            StringEquals: { "cloudwatch:namespace": "AWS/RDS" },
          },
        })
      )
    }
    return role
  }

  private createFunctionLogGroup(
    id: string,
    name: string,
    environment: AuroraCostOptimizerProps["environment"]
  ): logs.LogGroup {
    const logGroup = new logs.LogGroup(this, id, {
      logGroupName: `/aws/lambda/aistudio-${environment}-${name}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy:
        environment === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    })
    cdk.Tags.of(logGroup).add("Environment", environment)
    cdk.Tags.of(logGroup).add("CostCenter", "Database")
    cdk.Tags.of(logGroup).add("Component", "AuroraCostOptimizer")
    cdk.Tags.of(logGroup).add("ManagedBy", "CDK")
    return logGroup
  }

  private createPauseResumeFunction(
    props: AuroraCostOptimizerProps
  ): lambda.Function {
    const role = this.createFunctionRole(
      "PauseResumeFunctionRole",
      "PauseResumeLambdaBasicExecPolicy",
      props.cluster.clusterArn,
      true
    )
    const logGroup = this.createFunctionLogGroup(
      "PauseResumeFunctionLogGroup",
      "aurora-pause-resume",
      props.environment
    )
    return new lambda.Function(this, "PauseResumeFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "pause_resume.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../../lambdas/aurora-cost-optimizer")
      ),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      role,
      reservedConcurrentExecutions: 1,
      environment: {
        CLUSTER_IDENTIFIER: props.cluster.clusterIdentifier,
        ENVIRONMENT: props.environment,
        IDLE_MINUTES_THRESHOLD: (
          props.idleMinutesBeforePause ?? 30
        ).toString(),
      },
      logGroup,
      description: `Aurora cost optimizer for ${props.environment} environment`,
    })
  }

  private configureAutoPause(props: AuroraCostOptimizerProps): void {
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
    this.pauseResumeFunction
      .metricErrors({ period: cdk.Duration.hours(1) })
      .createAlarm(this, "PauseResumeErrorAlarm", {
        threshold: 3,
        evaluationPeriods: 1,
        alarmDescription: `Aurora pause/resume function errors in ${props.environment}`,
        treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
      })
  }

  private createScalingFunction(
    props: AuroraCostOptimizerProps
  ): lambda.Function {
    const role = this.createFunctionRole(
      "ScalingFunctionRole",
      "ScalingLambdaBasicExecPolicy",
      props.cluster.clusterArn,
      false
    )
    const logGroup = this.createFunctionLogGroup(
      "ScalingFunctionLogGroup",
      "aurora-scaling",
      props.environment
    )
    return new lambda.Function(this, "ScalingFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "predictive_scaling.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../../lambdas/aurora-cost-optimizer")
      ),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      role,
      reservedConcurrentExecutions: 1,
      environment: {
        CLUSTER_IDENTIFIER: props.cluster.clusterIdentifier,
        ENVIRONMENT: props.environment,
      },
      logGroup,
      description: `Aurora predictive scaling for ${props.environment} environment`,
    })
  }

  private configureScalingSchedules(
    props: AuroraCostOptimizerProps,
    scalingFunction: lambda.Function
  ): void {
    const businessHours = props.businessHours ?? {}
    const scaling = props.scaling ?? {}
    this.createScalingRule({
      id: "BusinessHoursScaleUp",
      hour: businessHours.scaleUpHour ?? 7,
      minute: "30",
      weekDay: businessHours.daysOfWeek ?? "MON-FRI",
      description: `Scale up Aurora for business hours (${props.environment})`,
      scalingFunction,
      minCapacity: scaling.businessHoursMin,
      maxCapacity: scaling.businessHoursMax,
      reason: "Business hours scale-up",
    })
    this.createScalingRule({
      id: "AfterHoursScaleDown",
      hour: businessHours.scaleDownHour ?? 20,
      minute: "0",
      weekDay: businessHours.daysOfWeek ?? "MON-FRI",
      description: `Scale down Aurora after business hours (${props.environment})`,
      scalingFunction,
      minCapacity: scaling.offHoursMin ?? 0.5,
      maxCapacity: scaling.offHoursMax,
      reason: "After hours scale-down",
    })
    if (props.environment !== "dev") {
      this.createScalingRule({
        id: "WeekendMinimalScale",
        hour: 0,
        minute: "0",
        weekDay: "SAT",
        description: `Minimal weekend scaling for Aurora (${props.environment})`,
        scalingFunction,
        minCapacity: 0.5,
        maxCapacity: scaling.offHoursMax ?? 1,
        reason: "Weekend minimal capacity",
      })
    }
  }

  private createScalingRule(params: {
    id: string
    hour: number
    minute: string
    weekDay: string
    description: string
    scalingFunction: lambda.Function
    minCapacity?: number
    maxCapacity?: number
    reason: string
  }): void {
    const rule = new events.Rule(this, params.id, {
      schedule: events.Schedule.cron({
        hour: params.hour.toString(),
        minute: params.minute,
        weekDay: params.weekDay,
      }),
      description: params.description,
    })
    rule.addTarget(
      new targets.LambdaFunction(params.scalingFunction, {
        event: events.RuleTargetInput.fromObject({
          minCapacity: params.minCapacity,
          maxCapacity: params.maxCapacity,
          reason: params.reason,
        }),
      })
    )
  }

  private createConfigurationOutputs(
    environment: AuroraCostOptimizerProps["environment"],
    enableAutoPause: boolean,
    enableScheduledScaling: boolean
  ): void {
    new cdk.CfnOutput(this, "AutoPauseEnabled", {
      value: enableAutoPause.toString(),
      description: `Auto-pause enabled for ${environment}`,
    })
    new cdk.CfnOutput(this, "ScheduledScalingEnabled", {
      value: enableScheduledScaling.toString(),
      description: `Scheduled scaling enabled for ${environment}`,
    })
  }
}
