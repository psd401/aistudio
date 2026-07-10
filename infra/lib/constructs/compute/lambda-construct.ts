import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as iam from "aws-cdk-lib/aws-iam"
import * as logs from "aws-cdk-lib/aws-logs"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import { Construct } from "constructs"
import { IEnvironmentConfig } from "../config/environment-config"

/**
 * Shared Lambda runtime for the agent platform. Bump this ONE constant to migrate
 * every agent Lambda + the LambdaConstruct default off a deprecated runtime
 * (REV-INFRA-125). nodejs20.x was deprecated 2026-04-30; nodejs22.x is the current LTS.
 */
export const AGENT_LAMBDA_RUNTIME = lambda.Runtime.NODEJS_22_X

export interface LambdaConstructProps {
  functionName: string
  handler: string
  codePath: string
  environment: Record<string, string>
  config: IEnvironmentConfig
  memorySize?: number
  timeout?: cdk.Duration
  vpc?: ec2.IVpc
  securityGroups?: ec2.ISecurityGroup[]
  runtime?: lambda.Runtime
  reservedConcurrentExecutions?: number
}

export class LambdaConstruct extends Construct {
  public readonly function: lambda.Function
  public readonly logGroup: logs.LogGroup
  private readonly tracingMode: lambda.Tracing

  constructor(scope: Construct, id: string, props: LambdaConstructProps) {
    super(scope, id)

    // Store tracing mode for later use
    this.tracingMode = props.config.monitoring.tracingEnabled
      ? lambda.Tracing.ACTIVE
      : lambda.Tracing.DISABLED

    // Create log group with retention from config
    this.logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/aws/lambda/${props.functionName}`,
      retention: props.config.monitoring.logRetention,
      removalPolicy: props.config.database.deletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    })

    // Create Lambda function with optimized settings
    this.function = new lambda.Function(this, "Function", {
      functionName: props.functionName,
      runtime: props.runtime || AGENT_LAMBDA_RUNTIME,
      handler: props.handler,
      code: lambda.Code.fromAsset(props.codePath, {
        bundling: this.createBundlingOptions(props.runtime),
      }),
      memorySize: props.memorySize || props.config.compute.lambdaMemory,
      timeout: props.timeout || props.config.compute.lambdaTimeout,
      environment: {
        NODE_ENV: props.config.costOptimization ? "production" : "development",
        LOG_LEVEL: props.config.monitoring.detailedMetrics ? "DEBUG" : "INFO",
        ...props.environment,
      },
      logGroup: this.logGroup,
      tracing: this.tracingMode,
      vpc: props.vpc,
      securityGroups: props.securityGroups,
      reservedConcurrentExecutions: props.reservedConcurrentExecutions,
      // Performance optimizations
      architecture: lambda.Architecture.ARM_64, // Graviton2 for better price/performance
      ephemeralStorageSize: cdk.Size.gibibytes(1), // Increase /tmp storage
    })

    // Add cost optimization for development
    if (props.config.costOptimization) {
      this.function.addEnvironment(
        "AWS_NODEJS_CONNECTION_REUSE_ENABLED",
        "1"
      )
    }

    // Add standard permissions
    this.addStandardPermissions()
  }

  private createBundlingOptions(
    runtime?: lambda.Runtime
  ): cdk.BundlingOptions | undefined {
    const isNodejs =
      !runtime || runtime.family === lambda.RuntimeFamily.NODEJS

    if (isNodejs) {
      return {
        image: AGENT_LAMBDA_RUNTIME.bundlingImage,
        command: [
          "bash",
          "-c",
          [
            "npm ci --production",
            "npm run build",
            "cp -r dist/* /asset-output/",
            "cp -r node_modules /asset-output/",
          ].join(" && "),
        ],
        environment: {
          NPM_CONFIG_CACHE: "/tmp/.npm",
        },
      }
    }

    return undefined
  }

  private addStandardPermissions(): void {
    // CloudWatch Logs permissions (already granted by default)

    // X-Ray permissions if tracing is enabled
    if (this.tracingMode === lambda.Tracing.ACTIVE) {
      this.function.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
          resources: ["*"],
        })
      )
    }
  }

  public grantInvoke(grantee: iam.IGrantable): iam.Grant {
    return this.function.grantInvoke(grantee)
  }

  public addEnvironment(key: string, value: string): void {
    this.function.addEnvironment(key, value)
  }
}
