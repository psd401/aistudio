import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as iam from "aws-cdk-lib/aws-iam"
import * as logs from "aws-cdk-lib/aws-logs"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch"
import { Construct } from "constructs"
import { IEnvironmentConfig } from "../config/environment-config"

/**
 * Performance profile determines optimization strategy
 * - critical: Low-latency, provisioned concurrency, highest reliability
 * - standard: Balanced performance and cost
 * - batch: High memory, longer timeout, cost-optimized for batch workloads
 */
export type PerformanceProfile = "critical" | "standard" | "batch"

/**
 * Cost optimization target for PowerTuning
 * - minimize: Minimize cost, accept longer execution times
 * - balanced: Balance cost and performance (recommended)
 * - maximize-performance: Minimize execution time, higher cost acceptable
 */
export type CostTarget = "minimize" | "balanced" | "maximize-performance"

export interface PowerTuningConfig {
  /** Enable PowerTuning state machine execution */
  enabled: boolean
  /** Cost optimization target */
  targetCost?: CostTarget
  /** Custom PowerTuning result if already performed */
  tunedMemorySize?: number
  /** Custom timeout from tuning results */
  tunedTimeout?: cdk.Duration
}

export interface ConcurrencyConfig {
  /** Reserved concurrent executions (prevents throttling) */
  reserved?: number
  /** Provisioned concurrent executions (reduces cold starts) */
  provisioned?: number
  /** Enable auto-scaling for provisioned concurrency */
  autoScaling?: {
    minCapacity: number
    maxCapacity: number
    targetUtilization: number
  }
}

export interface OptimizedLambdaProps {
  /** Unique function name */
  functionName: string
  /** Lambda handler (e.g., "index.handler") */
  handler: string
  /** Path to Lambda code directory */
  codePath: string
  /** Environment variables */
  environment?: Record<string, string>
  /** Environment configuration */
  config: IEnvironmentConfig

  // Performance configuration
  /** Performance profile determines optimization strategy */
  performanceProfile?: PerformanceProfile
  /** PowerTuning configuration */
  powerTuning?: PowerTuningConfig
  /** Memory size in MB (if not using PowerTuning) */
  memorySize?: number
  /** Function timeout (if not using PowerTuning) */
  timeout?: cdk.Duration

  // Architecture
  /** Lambda runtime (defaults to Node.js 20 on ARM64) */
  runtime?: lambda.Runtime
  /** Use ARM64/Graviton2 architecture (default: true) */
  enableGraviton?: boolean

  // Concurrency
  /** Concurrency configuration */
  concurrency?: ConcurrencyConfig

  // Networking
  /** VPC for Lambda function */
  vpc?: ec2.IVpc
  /** Security groups */
  securityGroups?: ec2.ISecurityGroup[]

  // Observability
  /** Enable X-Ray tracing (default: from config) */
  enableXRay?: boolean
  /** Enable Lambda Insights for enhanced monitoring */
  enableInsights?: boolean
  /**
   * @deprecated CodeGuru Profiler does not support the construct's Node.js 20
   * runtime. Retained only for source compatibility.
   */
  enableProfiling?: boolean
  /** Custom log retention (default: from config) */
  logRetention?: logs.RetentionDays

  // Bundling
  /** Use optimized esbuild bundling (default: true for Node.js) */
  enableOptimizedBundling?: boolean
  /** External modules to exclude from bundle */
  externalModules?: string[]
}

/**
 * OptimizedLambda - A comprehensive Lambda construct with built-in optimizations
 *
 * Features:
 * - AWS Lambda PowerTuning integration for right-sizing
 * - Graviton2 (ARM64) for 40% better price/performance
 * - Intelligent esbuild bundling with tree-shaking
 * - X-Ray tracing and CloudWatch Insights
 * - Provisioned & reserved concurrency management
 * - Performance monitoring dashboard
 * - Cost tracking with detailed tags
 *
 * Based on ADR-005: Lambda Function Comprehensive Optimization
 * Part of Epic #372 - CDK Infrastructure Optimization
 */
export class OptimizedLambda extends Construct {
  public readonly function: lambda.Function
  public readonly logGroup: logs.LogGroup
  public readonly alias?: lambda.Alias
  /**
   * @deprecated Dashboard creation removed in favor of consolidated dashboards (PR #424).
   * Metrics are now exported via the metrics Map and rendered in MonitoringStack.
   * This property will be removed in a future PR.
   */
  public readonly dashboard?: cloudwatch.Dashboard
  private readonly metrics: Map<string, cloudwatch.IMetric>

  constructor(scope: Construct, id: string, props: OptimizedLambdaProps) {
    super(scope, id)

    this.metrics = new Map()

    // Determine optimal configuration based on profile and PowerTuning
    const config = this.getOptimalConfiguration(props)

    // Create optimized log group with appropriate retention
    this.logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/aws/lambda/${props.functionName}`,
      retention:
        props.logRetention ||
        this.getLogRetention(props.performanceProfile || "standard"),
      removalPolicy:
        props.performanceProfile === "critical"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    })

    // Determine runtime and architecture
    const runtime = props.runtime || lambda.Runtime.NODEJS_20_X
    const architecture =
      props.enableGraviton !== false
        ? lambda.Architecture.ARM_64
        : lambda.Architecture.X86_64

    // Create Lambda function with optimizations
    this.function = new lambda.Function(this, "Function", {
      functionName: props.functionName,
      runtime,
      handler: props.handler,
      code: this.createOptimizedCode(
        props.codePath,
        runtime,
        props.enableOptimizedBundling !== false,
        props.externalModules
      ),

      // Memory and timeout from PowerTuning or intelligent defaults
      memorySize: config.memory,
      timeout: config.timeout,

      // Architecture optimization - Graviton2 for better price/performance
      architecture,

      // Ephemeral storage - 1GB provides good balance
      ephemeralStorageSize: cdk.Size.gibibytes(1),

      // Environment with performance optimizations
      environment: {
        ...this.getPerformanceEnvironment(architecture, runtime),
        NODE_ENV: props.config.costOptimization ? "production" : "development",
        LOG_LEVEL: props.config.monitoring.detailedMetrics ? "DEBUG" : "INFO",
        ...props.environment,
      },

      // Concurrency management
      reservedConcurrentExecutions: config.reservedConcurrency,

      // X-Ray tracing
      tracing:
        props.enableXRay !== false && props.config.monitoring.tracingEnabled
          ? lambda.Tracing.ACTIVE
          : lambda.Tracing.DISABLED,

      // Logging configuration
      logGroup: this.logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevel:
        props.performanceProfile === "critical"
          ? lambda.ApplicationLogLevel.INFO
          : lambda.ApplicationLogLevel.WARN,
      systemLogLevel: lambda.SystemLogLevel.WARN,

      // Dead letter queue for critical functions
      deadLetterQueueEnabled: props.performanceProfile === "critical",

      // Lambda Insights for enhanced monitoring
      insightsVersion:
        props.enableInsights !== false
          ? lambda.LambdaInsightsVersion.VERSION_1_0_229_0
          : undefined,

      // Networking
      vpc: props.vpc,
      securityGroups: props.securityGroups,
    })

    // Add X-Ray permissions if tracing is enabled
    if (
      props.enableXRay !== false &&
      props.config.monitoring.tracingEnabled
    ) {
      this.function.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
          resources: ["*"],
        })
      )
    }

    // Add provisioned concurrency with optional auto-scaling
    if (
      props.concurrency?.provisioned &&
      props.performanceProfile === "critical"
    ) {
      this.alias = this.function.addAlias("live", {
        provisionedConcurrentExecutions: props.concurrency.provisioned,
        description: `Live alias with ${props.concurrency.provisioned} provisioned executions`,
      })

      // Configure auto-scaling if specified
      if (props.concurrency.autoScaling) {
        const target = this.alias.addAutoScaling({
          minCapacity: props.concurrency.autoScaling.minCapacity,
          maxCapacity: props.concurrency.autoScaling.maxCapacity,
        })

        target.scaleOnUtilization({
          utilizationTarget: props.concurrency.autoScaling.targetUtilization,
        })
      }
    }

    // Store metrics for consolidated dashboards
    this.storeMetricsForConsolidation(props.functionName)
    this.dashboard = undefined

    // Add cost allocation tags for tracking
    this.addCostTags(props, config)
  }

  /**
   * Determine optimal Lambda configuration based on performance profile and PowerTuning
   */
  private getOptimalConfiguration(props: OptimizedLambdaProps): {
    memory: number
    timeout: cdk.Duration
    reservedConcurrency?: number
  } {
    // Use PowerTuning results if available
    if (props.powerTuning?.tunedMemorySize) {
      return {
        memory: props.powerTuning.tunedMemorySize,
        timeout: props.powerTuning.tunedTimeout || cdk.Duration.minutes(3),
        reservedConcurrency: props.concurrency?.reserved,
      }
    }

    // Use explicit values if provided
    if (props.memorySize) {
      return {
        memory: props.memorySize,
        timeout: props.timeout || cdk.Duration.minutes(3),
        reservedConcurrency: props.concurrency?.reserved,
      }
    }

    // Intelligent defaults based on performance profile
    const profile = props.performanceProfile || "standard"
    const profiles = {
      critical: {
        memory: 1536, // Balanced memory for consistent performance
        timeout: cdk.Duration.minutes(5),
        reservedConcurrency: props.concurrency?.reserved || 10,
      },
      standard: {
        memory: props.config.compute.lambdaMemory,
        timeout: props.config.compute.lambdaTimeout,
        reservedConcurrency: props.concurrency?.reserved || 5,
      },
      batch: {
        memory: 3008, // High memory for batch processing
        timeout: cdk.Duration.minutes(15),
        reservedConcurrency: props.concurrency?.reserved || 2,
      },
    }

    return profiles[profile]
  }

  /**
   * Create optimized code bundle using esbuild for Node.js
   */
  private createOptimizedCode(
    codePath: string,
    runtime: lambda.Runtime,
    enableOptimizedBundling: boolean,
    externalModules?: string[]
  ): lambda.Code {
    const isNodejs = runtime.family === lambda.RuntimeFamily.NODEJS

    // For Node.js, use optimized esbuild bundling
    if (isNodejs && enableOptimizedBundling) {
      return lambda.Code.fromAsset(codePath, {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            "bash",
            "-c",
            [
              // Install dependencies
              "npm ci --production --no-audit",

              // Install esbuild for fast bundling
              "npm install -g esbuild",

              // Bundle with tree-shaking and minification
              "esbuild",
              "--bundle",
              "--minify",
              "--sourcemap",
              "--tree-shaking=true",
              "--platform=node",
              "--target=node20",
              "--format=cjs",
              "--main-fields=module,main",
              externalModules?.length
                ? `--external:${externalModules.join(",")}`
                : "",
              "*.ts *.js",
              "--outdir=/asset-output/",

              // Copy native dependencies and external modules if needed
              externalModules?.length
                ? "cp -r node_modules /asset-output/ 2>/dev/null || true"
                : "",

              // Optimize node_modules if copied
              externalModules?.length
                ? [
                    "find /asset-output/node_modules -name '*.md' -type f -delete",
                    "find /asset-output/node_modules -name '*.ts' -type f -delete",
                    "find /asset-output/node_modules -name 'test' -type d -exec rm -rf {} + 2>/dev/null || true",
                    "find /asset-output/node_modules -name 'tests' -type d -exec rm -rf {} + 2>/dev/null || true",
                    "find /asset-output/node_modules -name '*.map' -type f -delete",
                  ].join(" && ")
                : "",
            ]
              .filter(Boolean)
              .join(" && "),
          ],
          environment: {
            NODE_ENV: "production",
            NPM_CONFIG_CACHE: "/tmp/.npm",
          },
        },
      })
    }

    // For other runtimes or when optimized bundling is disabled, use standard approach
    return lambda.Code.fromAsset(codePath, {
      bundling: isNodejs
        ? {
            image: lambda.Runtime.NODEJS_20_X.bundlingImage,
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
        : undefined,
    })
  }

  /**
   * Get performance-optimized environment variables
   */
  private getPerformanceEnvironment(
    architecture: lambda.Architecture,
    runtime: lambda.Runtime
  ): Record<string, string> {
    const isARM = architecture === lambda.Architecture.ARM_64
    const isNodejs = runtime.family === lambda.RuntimeFamily.NODEJS

    const baseEnv: Record<string, string> = {}

    if (isNodejs) {
      baseEnv.NODE_OPTIONS = "--enable-source-maps"
      baseEnv.AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
      baseEnv.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE = "1"

      // ARM64-specific Node.js optimizations
      if (isARM) {
        baseEnv.UV_THREADPOOL_SIZE = "8" // Leverage more cores
        baseEnv.MALLOC_ARENA_MAX = "2" // Reduce memory fragmentation
      }
    }

    return baseEnv
  }

  /**
   * Get log retention based on performance profile
   */
  private getLogRetention(profile: PerformanceProfile): logs.RetentionDays {
    switch (profile) {
      case "critical":
        return logs.RetentionDays.ONE_MONTH
      case "batch":
        return logs.RetentionDays.ONE_WEEK
      default:
        return logs.RetentionDays.THREE_DAYS
    }
  }

  /**
   * Store Lambda metrics for external access (dashboard consolidation)
   *
   * Metrics are stored in this.metrics Map and can be accessed via metric() method.
   * Dashboard creation removed - metrics now exported to consolidated dashboards.
   */
  private storeMetricsForConsolidation(functionName: string): void {
    // Core Lambda metrics
    const invocations = this.function.metricInvocations({
      statistic: "Sum",
      period: cdk.Duration.minutes(5),
    })

    const errors = this.function.metricErrors({
      statistic: "Sum",
      period: cdk.Duration.minutes(5),
    })

    const throttles = this.function.metricThrottles({
      statistic: "Sum",
      period: cdk.Duration.minutes(5),
    })

    const duration = this.function.metricDuration({
      statistic: "Average",
      period: cdk.Duration.minutes(5),
    })

    const concurrentExecutions = this.function.metric(
      "ConcurrentExecutions",
      {
        statistic: "Maximum",
        period: cdk.Duration.minutes(5),
      }
    )

    // Store metrics for external access
    this.metrics.set("invocations", invocations)
    this.metrics.set("errors", errors)
    this.metrics.set("throttles", throttles)
    this.metrics.set("duration", duration)
    this.metrics.set("concurrentExecutions", concurrentExecutions)

    // Error rate calculation
    const errorRate = new cloudwatch.MathExpression({
      expression: "(errors / invocations) * 100",
      usingMetrics: { errors, invocations },
      label: "Error Rate (%)",
      period: cdk.Duration.minutes(5),
    })
    this.metrics.set("errorRate", errorRate)

    // Cost estimation (approximate)
    const estimatedCost = new cloudwatch.MathExpression({
      expression: "(invocations * duration / 1000) * 0.0000166667",
      usingMetrics: { invocations, duration },
      label: "Estimated Cost ($/hour)",
      period: cdk.Duration.hours(1),
    })
    this.metrics.set("estimatedCost", estimatedCost)

    // Dashboard creation removed - metrics available via metric() method for consolidated dashboards
  }

  /**
   * Add cost allocation tags for tracking and optimization
   */
  private addCostTags(
    props: OptimizedLambdaProps,
    config: { memory: number }
  ): void {
    const architecture =
      props.enableGraviton !== false ? "ARM64" : "X86_64"
    const profile = props.performanceProfile || "standard"
    const isPowerTuned = !!props.powerTuning?.tunedMemorySize

    cdk.Tags.of(this.function).add("Architecture", architecture)
    cdk.Tags.of(this.function).add("PerformanceProfile", profile)
    cdk.Tags.of(this.function).add("PowerTuned", String(isPowerTuned))
    cdk.Tags.of(this.function).add("OptimizedMemory", String(config.memory))
    cdk.Tags.of(this.function).add(
      "Optimized",
      "true"
    )
    cdk.Tags.of(this.function).add("ManagedBy", "OptimizedLambda")
  }

  /**
   * Grant invoke permissions
   */
  public grantInvoke(grantee: iam.IGrantable): iam.Grant {
    return this.function.grantInvoke(grantee)
  }

  /**
   * Add environment variable
   */
  public addEnvironment(key: string, value: string): void {
    this.function.addEnvironment(key, value)
  }

  /**
   * Get a metric by name
   */
  public metric(metricName: string): cloudwatch.IMetric | undefined {
    return this.metrics.get(metricName)
  }

  /**
   * Add IAM policy statement to function role
   */
  public addToRolePolicy(statement: iam.PolicyStatement): void {
    this.function.addToRolePolicy(statement)
  }
}
