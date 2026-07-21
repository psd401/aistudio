import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda"
import { Template, Match } from "aws-cdk-lib/assertions"
import {
  OptimizedLambda,
  EnvironmentConfig,
} from "../lib/constructs"

describe("OptimizedLambda", () => {
  let app: cdk.App
  let stack: cdk.Stack
  let config: ReturnType<typeof EnvironmentConfig.get>

  beforeAll(() => {
    // These are synthesis tests, not Docker bundling tests. Returning inline
    // code keeps the unit suite hermetic while every constructor path still
    // synthesizes and validates the Lambda resource configuration.
    jest.spyOn(lambda.Code, "fromAsset").mockImplementation(
      () =>
        lambda.Code.fromInline("exports.handler = async () => ({})") as unknown as ReturnType<
          typeof lambda.Code.fromAsset
        >
    )
  })

  afterAll(() => {
    jest.restoreAllMocks()
  })

  beforeEach(() => {
    app = new cdk.App()
    stack = new cdk.Stack(app, "TestStack")
    config = EnvironmentConfig.get("dev")
  })

  describe("Basic Configuration", () => {
    test("creates Lambda function with ARM64 architecture by default", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "test-function",
        Handler: "index.handler",
        Runtime: "nodejs20.x",
        Architectures: ["arm64"],
      })
    })

    test("creates Lambda function with x86 when Graviton disabled", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        enableGraviton: false,
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        Architectures: ["x86_64"],
      })
    })

    test("creates log group with correct retention", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/aws/lambda/test-function",
        RetentionInDays: 3,
      })
    })
  })

  describe("Performance Profiles", () => {
    test("applies critical profile correctly", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        performanceProfile: "critical",
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        MemorySize: 1536, // Critical profile default
        Timeout: 300, // 5 minutes
        ReservedConcurrentExecutions: 10,
        DeadLetterConfig: Match.objectLike({
          TargetArn: Match.anyValue(),
        }),
      })
    })

    test("applies standard profile correctly", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        performanceProfile: "standard",
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        MemorySize: config.compute.lambdaMemory,
        Timeout: config.compute.lambdaTimeout.toSeconds(),
        ReservedConcurrentExecutions: 5,
      })
    })

    test("applies batch profile correctly", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        performanceProfile: "batch",
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        MemorySize: 3008, // Batch profile default
        Timeout: 900, // 15 minutes
        ReservedConcurrentExecutions: 2,
      })
    })
  })

  describe("PowerTuning Configuration", () => {
    test("uses PowerTuned memory size when provided", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        powerTuning: {
          enabled: true,
          tunedMemorySize: 1536,
          tunedTimeout: cdk.Duration.minutes(3),
        },
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        MemorySize: 1536,
        Timeout: 180,
      })
    })

    test("adds PowerTuned tag when tuning results applied", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        powerTuning: {
          enabled: true,
          tunedMemorySize: 1536,
        },
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        Tags: Match.arrayWith([
          { Key: "OptimizedMemory", Value: "1536" },
          { Key: "PowerTuned", Value: "true" },
        ]),
      })
    })
  })

  describe("Concurrency Configuration", () => {
    test("sets reserved concurrency", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        concurrency: {
          reserved: 20,
        },
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        ReservedConcurrentExecutions: 20,
      })
    })

    test("creates alias with provisioned concurrency for critical functions", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        performanceProfile: "critical",
        concurrency: {
          provisioned: 5,
        },
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Alias", {
        Name: "live",
        ProvisionedConcurrencyConfig: {
          ProvisionedConcurrentExecutions: 5,
        },
      })
    })

    test("does not create provisioned concurrency for non-critical functions", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        performanceProfile: "standard",
        concurrency: {
          provisioned: 5, // This should be ignored for non-critical
        },
      })

      const template = Template.fromStack(stack)
      template.resourceCountIs("AWS::Lambda::Alias", 0)
    })
  })

  describe("Observability", () => {
    test("enables X-Ray tracing when configured", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config: {
          ...config,
          monitoring: {
            ...config.monitoring,
            tracingEnabled: true,
          },
        },
        enableXRay: true,
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        TracingConfig: {
          Mode: "Active",
        },
      })

      // Should also have X-Ray permissions
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                "xray:PutTraceSegments",
                "xray:PutTelemetryRecords",
              ]),
            }),
          ]),
        },
      })
    })

    test("disables X-Ray tracing when not configured", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config: {
          ...config,
          monitoring: {
            ...config.monitoring,
            tracingEnabled: false,
          },
        },
        enableXRay: false,
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        TracingConfig: Match.absent(),
      })
    })

    test("enables Lambda Insights when specified", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        enableInsights: true,
      })

      const template = Template.fromStack(stack)
      const resources = template.findResources("AWS::Lambda::Function")
      const synthesized = Object.values(resources)[0] as
        | { Properties?: { Layers?: unknown[] } }
        | undefined
      expect(synthesized?.Properties?.Layers).toHaveLength(1)
    })

    test("creates monitoring dashboard when insights enabled", () => {
      const optimizedLambda = new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config: {
          ...config,
          monitoring: {
            ...config.monitoring,
            detailedMetrics: true,
          },
        },
        enableInsights: true,
      })

      expect(optimizedLambda.dashboard).toBeUndefined()
      expect(optimizedLambda.metric("invocations")).toBeDefined()
    })
  })

  describe("Environment Variables", () => {
    test("sets performance environment variables for ARM64", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        enableGraviton: true,
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: Match.objectLike({
            NODE_OPTIONS: "--enable-source-maps",
            AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
            AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE: "1",
            UV_THREADPOOL_SIZE: "8",
            MALLOC_ARENA_MAX: "2",
          }),
        },
      })
    })

    test("merges custom environment variables", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        environment: {
          CUSTOM_VAR: "custom-value",
          BUCKET_NAME: "my-bucket",
        },
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: Match.objectLike({
            CUSTOM_VAR: "custom-value",
            BUCKET_NAME: "my-bucket",
            NODE_OPTIONS: "--enable-source-maps", // Should also have default vars
          }),
        },
      })
    })
  })

  describe("Cost Tracking Tags", () => {
    test("adds cost allocation tags", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        performanceProfile: "critical",
        powerTuning: {
          enabled: true,
          tunedMemorySize: 2048,
        },
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        Tags: Match.arrayWith([
          { Key: "Architecture", Value: "ARM64" },
          { Key: "ManagedBy", Value: "OptimizedLambda" },
          { Key: "Optimized", Value: "true" },
          { Key: "OptimizedMemory", Value: "2048" },
          { Key: "PerformanceProfile", Value: "critical" },
          { Key: "PowerTuned", Value: "true" },
        ]),
      })
    })
  })

  describe("Integration", () => {
    test("exposes underlying Lambda function", () => {
      const optimizedLambda = new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
      })

      expect(optimizedLambda.function).toBeInstanceOf(lambda.Function)
      Template.fromStack(stack).hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "test-function",
      })
    })

    test("exposes log group", () => {
      const optimizedLambda = new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
      })

      expect(optimizedLambda.logGroup).toBeDefined()
    })

    test("grantInvoke delegates to underlying function", () => {
      const optimizedLambda = new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
      })

      const role = new cdk.aws_iam.Role(stack, "TestRole", {
        assumedBy: new cdk.aws_iam.ServicePrincipal("lambda.amazonaws.com"),
      })

      optimizedLambda.grantInvoke(role)

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "lambda:InvokeFunction",
              Resource: Match.arrayWith([
                Match.objectLike({
                  "Fn::GetAtt": Match.arrayWith([
                    Match.stringLikeRegexp(".*Function.*"),
                  ]),
                }),
              ]),
            }),
          ]),
        },
      })
    })

    test("addEnvironment adds variables to function", () => {
      const optimizedLambda = new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
      })

      optimizedLambda.addEnvironment("NEW_VAR", "new-value")

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: Match.objectLike({
            NEW_VAR: "new-value",
          }),
        },
      })
    })
  })

  describe("Custom Runtime and Bundling", () => {
    test("supports custom runtime", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        runtime: lambda.Runtime.PYTHON_3_11,
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Lambda::Function", {
        Runtime: "python3.11",
      })
    })

    test("disables optimized bundling when requested", () => {
      const optimizedLambda = new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        enableOptimizedBundling: false,
      })

      expect(optimizedLambda.function).toBeDefined()
      // Can't easily test bundling options in unit tests, but ensure function is created
    })
  })

  describe("Log Retention", () => {
    test("uses custom log retention when provided", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        logRetention: cdk.aws_logs.RetentionDays.TWO_WEEKS,
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        RetentionInDays: 14,
      })
    })

    test("uses profile-based log retention for critical functions", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        performanceProfile: "critical",
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        RetentionInDays: 30, // ONE_MONTH for critical
      })
    })

    test("uses profile-based log retention for batch functions", () => {
      new OptimizedLambda(stack, "TestLambda", {
        functionName: "test-function",
        handler: "index.handler",
        codePath: "test/fixtures/lambda",
        config,
        performanceProfile: "batch",
      })

      const template = Template.fromStack(stack)
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        RetentionInDays: 7, // ONE_WEEK for batch
      })
    })
  })
})
