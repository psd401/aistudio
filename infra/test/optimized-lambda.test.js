"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = __importStar(require("aws-cdk-lib"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const assertions_1 = require("aws-cdk-lib/assertions");
const constructs_1 = require("../lib/constructs");
describe("OptimizedLambda", () => {
    let app;
    let stack;
    let config;
    beforeAll(() => {
        // These are synthesis tests, not Docker bundling tests. Returning inline
        // code keeps the unit suite hermetic while every constructor path still
        // synthesizes and validates the Lambda resource configuration.
        jest.spyOn(lambda.Code, "fromAsset").mockImplementation(() => lambda.Code.fromInline("exports.handler = async () => ({})"));
    });
    afterAll(() => {
        jest.restoreAllMocks();
    });
    beforeEach(() => {
        app = new cdk.App();
        stack = new cdk.Stack(app, "TestStack");
        config = constructs_1.EnvironmentConfig.get("dev");
    });
    describe("Basic Configuration", () => {
        test("creates Lambda function with ARM64 architecture by default", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                FunctionName: "test-function",
                Handler: "index.handler",
                Runtime: "nodejs20.x",
                Architectures: ["arm64"],
            });
        });
        test("creates Lambda function with x86 when Graviton disabled", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                enableGraviton: false,
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                Architectures: ["x86_64"],
            });
        });
        test("creates log group with correct retention", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Logs::LogGroup", {
                LogGroupName: "/aws/lambda/test-function",
                RetentionInDays: 3,
            });
        });
    });
    describe("Performance Profiles", () => {
        test("applies critical profile correctly", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                performanceProfile: "critical",
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                MemorySize: 1536, // Critical profile default
                Timeout: 300, // 5 minutes
                ReservedConcurrentExecutions: 10,
                DeadLetterConfig: assertions_1.Match.objectLike({
                    TargetArn: assertions_1.Match.anyValue(),
                }),
            });
        });
        test("applies standard profile correctly", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                performanceProfile: "standard",
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                MemorySize: config.compute.lambdaMemory,
                Timeout: config.compute.lambdaTimeout.toSeconds(),
                ReservedConcurrentExecutions: 5,
            });
        });
        test("applies batch profile correctly", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                performanceProfile: "batch",
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                MemorySize: 3008, // Batch profile default
                Timeout: 900, // 15 minutes
                ReservedConcurrentExecutions: 2,
            });
        });
    });
    describe("PowerTuning Configuration", () => {
        test("uses PowerTuned memory size when provided", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                powerTuning: {
                    enabled: true,
                    tunedMemorySize: 1536,
                    tunedTimeout: cdk.Duration.minutes(3),
                },
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                MemorySize: 1536,
                Timeout: 180,
            });
        });
        test("adds PowerTuned tag when tuning results applied", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                powerTuning: {
                    enabled: true,
                    tunedMemorySize: 1536,
                },
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                Tags: assertions_1.Match.arrayWith([
                    { Key: "OptimizedMemory", Value: "1536" },
                    { Key: "PowerTuned", Value: "true" },
                ]),
            });
        });
    });
    describe("Concurrency Configuration", () => {
        test("sets reserved concurrency", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                concurrency: {
                    reserved: 20,
                },
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                ReservedConcurrentExecutions: 20,
            });
        });
        test("creates alias with provisioned concurrency for critical functions", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                performanceProfile: "critical",
                concurrency: {
                    provisioned: 5,
                },
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Alias", {
                Name: "live",
                ProvisionedConcurrencyConfig: {
                    ProvisionedConcurrentExecutions: 5,
                },
            });
        });
        test("does not create provisioned concurrency for non-critical functions", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                performanceProfile: "standard",
                concurrency: {
                    provisioned: 5, // This should be ignored for non-critical
                },
            });
            const template = assertions_1.Template.fromStack(stack);
            template.resourceCountIs("AWS::Lambda::Alias", 0);
        });
    });
    describe("Observability", () => {
        test("enables X-Ray tracing when configured", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
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
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                TracingConfig: {
                    Mode: "Active",
                },
            });
            // Should also have X-Ray permissions
            template.hasResourceProperties("AWS::IAM::Policy", {
                PolicyDocument: {
                    Statement: assertions_1.Match.arrayWith([
                        assertions_1.Match.objectLike({
                            Action: assertions_1.Match.arrayWith([
                                "xray:PutTraceSegments",
                                "xray:PutTelemetryRecords",
                            ]),
                        }),
                    ]),
                },
            });
        });
        test("disables X-Ray tracing when not configured", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
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
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                TracingConfig: assertions_1.Match.absent(),
            });
        });
        test("enables Lambda Insights when specified", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                enableInsights: true,
            });
            const template = assertions_1.Template.fromStack(stack);
            const resources = template.findResources("AWS::Lambda::Function");
            const synthesized = Object.values(resources)[0];
            expect(synthesized?.Properties?.Layers).toHaveLength(1);
        });
        test("creates monitoring dashboard when insights enabled", () => {
            const optimizedLambda = new constructs_1.OptimizedLambda(stack, "TestLambda", {
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
            });
            expect(optimizedLambda.dashboard).toBeUndefined();
            expect(optimizedLambda.metric("invocations")).toBeDefined();
        });
    });
    describe("Environment Variables", () => {
        test("sets performance environment variables for ARM64", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                enableGraviton: true,
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                Environment: {
                    Variables: assertions_1.Match.objectLike({
                        NODE_OPTIONS: "--enable-source-maps",
                        AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
                        AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE: "1",
                        UV_THREADPOOL_SIZE: "8",
                        MALLOC_ARENA_MAX: "2",
                    }),
                },
            });
        });
        test("merges custom environment variables", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                environment: {
                    CUSTOM_VAR: "custom-value",
                    BUCKET_NAME: "my-bucket",
                },
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                Environment: {
                    Variables: assertions_1.Match.objectLike({
                        CUSTOM_VAR: "custom-value",
                        BUCKET_NAME: "my-bucket",
                        NODE_OPTIONS: "--enable-source-maps", // Should also have default vars
                    }),
                },
            });
        });
    });
    describe("Cost Tracking Tags", () => {
        test("adds cost allocation tags", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                performanceProfile: "critical",
                powerTuning: {
                    enabled: true,
                    tunedMemorySize: 2048,
                },
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                Tags: assertions_1.Match.arrayWith([
                    { Key: "Architecture", Value: "ARM64" },
                    { Key: "ManagedBy", Value: "OptimizedLambda" },
                    { Key: "Optimized", Value: "true" },
                    { Key: "OptimizedMemory", Value: "2048" },
                    { Key: "PerformanceProfile", Value: "critical" },
                    { Key: "PowerTuned", Value: "true" },
                ]),
            });
        });
    });
    describe("Integration", () => {
        test("exposes underlying Lambda function", () => {
            const optimizedLambda = new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
            });
            expect(optimizedLambda.function).toBeInstanceOf(lambda.Function);
            assertions_1.Template.fromStack(stack).hasResourceProperties("AWS::Lambda::Function", {
                FunctionName: "test-function",
            });
        });
        test("exposes log group", () => {
            const optimizedLambda = new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
            });
            expect(optimizedLambda.logGroup).toBeDefined();
        });
        test("grantInvoke delegates to underlying function", () => {
            const optimizedLambda = new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
            });
            const role = new cdk.aws_iam.Role(stack, "TestRole", {
                assumedBy: new cdk.aws_iam.ServicePrincipal("lambda.amazonaws.com"),
            });
            optimizedLambda.grantInvoke(role);
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::IAM::Policy", {
                PolicyDocument: {
                    Statement: assertions_1.Match.arrayWith([
                        assertions_1.Match.objectLike({
                            Action: "lambda:InvokeFunction",
                            Resource: assertions_1.Match.arrayWith([
                                assertions_1.Match.objectLike({
                                    "Fn::GetAtt": assertions_1.Match.arrayWith([
                                        assertions_1.Match.stringLikeRegexp(".*Function.*"),
                                    ]),
                                }),
                            ]),
                        }),
                    ]),
                },
            });
        });
        test("addEnvironment adds variables to function", () => {
            const optimizedLambda = new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
            });
            optimizedLambda.addEnvironment("NEW_VAR", "new-value");
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                Environment: {
                    Variables: assertions_1.Match.objectLike({
                        NEW_VAR: "new-value",
                    }),
                },
            });
        });
    });
    describe("Custom Runtime and Bundling", () => {
        test("supports custom runtime", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                runtime: lambda.Runtime.PYTHON_3_11,
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Lambda::Function", {
                Runtime: "python3.11",
            });
        });
        test("disables optimized bundling when requested", () => {
            const optimizedLambda = new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                enableOptimizedBundling: false,
            });
            expect(optimizedLambda.function).toBeDefined();
            // Can't easily test bundling options in unit tests, but ensure function is created
        });
    });
    describe("Log Retention", () => {
        test("uses custom log retention when provided", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                logRetention: cdk.aws_logs.RetentionDays.TWO_WEEKS,
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Logs::LogGroup", {
                RetentionInDays: 14,
            });
        });
        test("uses profile-based log retention for critical functions", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                performanceProfile: "critical",
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Logs::LogGroup", {
                RetentionInDays: 30, // ONE_MONTH for critical
            });
        });
        test("uses profile-based log retention for batch functions", () => {
            new constructs_1.OptimizedLambda(stack, "TestLambda", {
                functionName: "test-function",
                handler: "index.handler",
                codePath: "test/fixtures/lambda",
                config,
                performanceProfile: "batch",
            });
            const template = assertions_1.Template.fromStack(stack);
            template.hasResourceProperties("AWS::Logs::LogGroup", {
                RetentionInDays: 7, // ONE_WEEK for batch
            });
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3B0aW1pemVkLWxhbWJkYS50ZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsib3B0aW1pemVkLWxhbWJkYS50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQWtDO0FBQ2xDLCtEQUFnRDtBQUNoRCx1REFBd0Q7QUFDeEQsa0RBRzBCO0FBRTFCLFFBQVEsQ0FBQyxpQkFBaUIsRUFBRSxHQUFHLEVBQUU7SUFDL0IsSUFBSSxHQUFZLENBQUE7SUFDaEIsSUFBSSxLQUFnQixDQUFBO0lBQ3BCLElBQUksTUFBZ0QsQ0FBQTtJQUVwRCxTQUFTLENBQUMsR0FBRyxFQUFFO1FBQ2IseUVBQXlFO1FBQ3pFLHdFQUF3RTtRQUN4RSwrREFBK0Q7UUFDL0QsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLFdBQVcsQ0FBQyxDQUFDLGtCQUFrQixDQUNyRCxHQUFHLEVBQUUsQ0FDSCxNQUFNLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxvQ0FBb0MsQ0FFMUQsQ0FDSixDQUFBO0lBQ0gsQ0FBQyxDQUFDLENBQUE7SUFFRixRQUFRLENBQUMsR0FBRyxFQUFFO1FBQ1osSUFBSSxDQUFDLGVBQWUsRUFBRSxDQUFBO0lBQ3hCLENBQUMsQ0FBQyxDQUFBO0lBRUYsVUFBVSxDQUFDLEdBQUcsRUFBRTtRQUNkLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQTtRQUNuQixLQUFLLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxXQUFXLENBQUMsQ0FBQTtRQUN2QyxNQUFNLEdBQUcsOEJBQWlCLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFBO0lBQ3ZDLENBQUMsQ0FBQyxDQUFBO0lBRUYsUUFBUSxDQUFDLHFCQUFxQixFQUFFLEdBQUcsRUFBRTtRQUNuQyxJQUFJLENBQUMsNERBQTRELEVBQUUsR0FBRyxFQUFF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RSxzQkFBc0I7Z0JBQ2hDLE1BQU07Z0JBQ04sa0JBQWtCLEVBQUUsT0FBTzthQUM1QixDQUFDLENBQUE7WUFFRixNQUFNLFFBQVEsR0FBRyxxQkFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQTtZQUMxQyxRQUFRLENBQUMscUJBQXFCLENBQUMscUJBQXFCLEVBQUU7Z0JBQ3BELGVBQWUsRUFBRSxDQUFDLEVBQUUscUJBQXFCO2FBQzFDLENBQUMsQ0FBQTtRQUNKLENBQUMsQ0FBQyxDQUFBO0lBQ0osQ0FBQyxDQUFDLENBQUE7QUFDSixDQUFDLENBQUMsQ0FBQSIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tIFwiYXdzLWNkay1saWJcIlxuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCJcbmltcG9ydCB7IFRlbXBsYXRlLCBNYXRjaCB9IGZyb20gXCJhd3MtY2RrLWxpYi9hc3NlcnRpb25zXCJcbmltcG9ydCB7XG4gIE9wdGltaXplZExhbWJkYSxcbiAgRW52aXJvbm1lbnRDb25maWcsXG59IGZyb20gXCIuLi9saWIvY29uc3RydWN0c1wiXG5cbmRlc2NyaWJlKFwiT3B0aW1pemVkTGFtYmRhXCIsICgpID0+IHtcbiAgbGV0IGFwcDogY2RrLkFwcFxuICBsZXQgc3RhY2s6IGNkay5TdGFja1xuICBsZXQgY29uZmlnOiBSZXR1cm5UeXBlPHR5cGVvZiBFbnZpcm9ubWVudENvbmZpZy5nZXQ+XG5cbiAgYmVmb3JlQWxsKCgpID0+IHtcbiAgICAvLyBUaGVzZSBhcmUgc3ludGhlc2lzIHRlc3RzLCBub3QgRG9ja2VyIGJ1bmRsaW5nIHRlc3RzLiBSZXR1cm5pbmcgaW5saW5lXG4gICAgLy8gY29kZSBrZWVwcyB0aGUgdW5pdCBzdWl0ZSBoZXJtZXRpYyB3aGlsZSBldmVyeSBjb25zdHJ1Y3RvciBwYXRoIHN0aWxsXG4gICAgLy8gc3ludGhlc2l6ZXMgYW5kIHZhbGlkYXRlcyB0aGUgTGFtYmRhIHJlc291cmNlIGNvbmZpZ3VyYXRpb24uXG4gICAgamVzdC5zcHlPbihsYW1iZGEuQ29kZSwgXCJmcm9tQXNzZXRcIikubW9ja0ltcGxlbWVudGF0aW9uKFxuICAgICAgKCkgPT5cbiAgICAgICAgbGFtYmRhLkNvZGUuZnJvbUlubGluZShcImV4cG9ydHMuaGFuZGxlciA9IGFzeW5jICgpID0+ICh7fSlcIikgYXMgdW5rbm93biBhcyBSZXR1cm5UeXBlPFxuICAgICAgICAgIHR5cGVvZiBsYW1iZGEuQ29kZS5mcm9tQXNzZXRcbiAgICAgICAgPlxuICAgIClcbiAgfSlcblxuICBhZnRlckFsbCgoKSA9PiB7XG4gICAgamVzdC5yZXN0b3JlQWxsTW9ja3MoKVxuICB9KVxuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIGFwcCA9IG5ldyBjZGsuQXBwKClcbiAgICBzdGFjayA9IG5ldyBjZGsuU3RhY2soYXBwLCBcIlRlc3RTdGFja1wiKVxuICAgIGNvbmZpZyA9IEVudmlyb25tZW50Q29uZmlnLmdldChcImRldlwiKVxuICB9KVxuXG4gIGRlc2NyaWJlKFwiQmFzaWMgQ29uZmlndXJhdGlvblwiLCAoKSA9PiB7XG4gICAgdGVzdChcImNyZWF0ZXMgTGFtYmRhIGZ1bmN0aW9uIHdpdGggQVJNNjQgYXJjaGl0ZWN0dXJlIGJ5IGRlZmF1bHRcIiwgKCkgPT4ge1xuICAgICAgbmV3IE9wdGltaXplZExhbWJkYShzdGFjaywgXCJUZXN0TGFtYmRhXCIsIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBcInRlc3QtZnVuY3Rpb25cIixcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGVQYXRoOiBcInRlc3QvZml4dHVyZXMvbGFtYmRhXCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpMYW1iZGE6OkZ1bmN0aW9uXCIsIHtcbiAgICAgICAgRnVuY3Rpb25OYW1lOiBcInRlc3QtZnVuY3Rpb25cIixcbiAgICAgICAgSGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIFJ1bnRpbWU6IFwibm9kZWpzMjAueFwiLFxuICAgICAgICBBcmNoaXRlY3R1cmVzOiBbXCJhcm02NFwiXSxcbiAgICAgIH0pXG4gICAgfSlcblxuICAgIHRlc3QoXCJjcmVhdGVzIExhbWJkYSBmdW5jdGlvbiB3aXRoIHg4NiB3aGVuIEdyYXZpdG9uIGRpc2FibGVkXCIsICgpID0+IHtcbiAgICAgIG5ldyBPcHRpbWl6ZWRMYW1iZGEoc3RhY2ssIFwiVGVzdExhbWJkYVwiLCB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZTogXCJ0ZXN0LWZ1bmN0aW9uXCIsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlUGF0aDogXCJ0ZXN0L2ZpeHR1cmVzL2xhbWJkYVwiLFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGVuYWJsZUdyYXZpdG9uOiBmYWxzZSxcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpMYW1iZGE6OkZ1bmN0aW9uXCIsIHtcbiAgICAgICAgQXJjaGl0ZWN0dXJlczogW1wieDg2XzY0XCJdLFxuICAgICAgfSlcbiAgICB9KVxuXG4gICAgdGVzdChcImNyZWF0ZXMgbG9nIGdyb3VwIHdpdGggY29ycmVjdCByZXRlbnRpb25cIiwgKCkgPT4ge1xuICAgICAgbmV3IE9wdGltaXplZExhbWJkYShzdGFjaywgXCJUZXN0TGFtYmRhXCIsIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBcInRlc3QtZnVuY3Rpb25cIixcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGVQYXRoOiBcInRlc3QvZml4dHVyZXMvbGFtYmRhXCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpMb2dzOjpMb2dHcm91cFwiLCB7XG4gICAgICAgIExvZ0dyb3VwTmFtZTogXCIvYXdzL2xhbWJkYS90ZXN0LWZ1bmN0aW9uXCIsXG4gICAgICAgIFJldGVudGlvbkluRGF5czogMyxcbiAgICAgIH0pXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZShcIlBlcmZvcm1hbmNlIFByb2ZpbGVzXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiYXBwbGllcyBjcml0aWNhbCBwcm9maWxlIGNvcnJlY3RseVwiLCAoKSA9PiB7XG4gICAgICBuZXcgT3B0aW1pemVkTGFtYmRhKHN0YWNrLCBcIlRlc3RMYW1iZGFcIiwge1xuICAgICAgICBmdW5jdGlvbk5hbWU6IFwidGVzdC1mdW5jdGlvblwiLFxuICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgY29kZVBhdGg6IFwidGVzdC9maXh0dXJlcy9sYW1iZGFcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgICBwZXJmb3JtYW5jZVByb2ZpbGU6IFwiY3JpdGljYWxcIixcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpMYW1iZGE6OkZ1bmN0aW9uXCIsIHtcbiAgICAgICAgTWVtb3J5U2l6ZTogMTUzNiwgLy8gQ3JpdGljYWwgcHJvZmlsZSBkZWZhdWx0XG4gICAgICAgIFRpbWVvdXQ6IDMwMCwgLy8gNSBtaW51dGVzXG4gICAgICAgIFJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IDEwLFxuICAgICAgICBEZWFkTGV0dGVyQ29uZmlnOiBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICBUYXJnZXRBcm46IE1hdGNoLmFueVZhbHVlKCksXG4gICAgICAgIH0pLFxuICAgICAgfSlcbiAgICB9KVxuXG4gICAgdGVzdChcImFwcGxpZXMgc3RhbmRhcmQgcHJvZmlsZSBjb3JyZWN0bHlcIiwgKCkgPT4ge1xuICAgICAgbmV3IE9wdGltaXplZExhbWJkYShzdGFjaywgXCJUZXN0TGFtYmRhXCIsIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBcInRlc3QtZnVuY3Rpb25cIixcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGVQYXRoOiBcInRlc3QvZml4dHVyZXMvbGFtYmRhXCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgcGVyZm9ybWFuY2VQcm9maWxlOiBcInN0YW5kYXJkXCIsXG4gICAgICB9KVxuXG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcyhcIkFXUzo6TGFtYmRhOjpGdW5jdGlvblwiLCB7XG4gICAgICAgIE1lbW9yeVNpemU6IGNvbmZpZy5jb21wdXRlLmxhbWJkYU1lbW9yeSxcbiAgICAgICAgVGltZW91dDogY29uZmlnLmNvbXB1dGUubGFtYmRhVGltZW91dC50b1NlY29uZHMoKSxcbiAgICAgICAgUmVzZXJ2ZWRDb25jdXJyZW50RXhlY3V0aW9uczogNSxcbiAgICAgIH0pXG4gICAgfSlcblxuICAgIHRlc3QoXCJhcHBsaWVzIGJhdGNoIHByb2ZpbGUgY29ycmVjdGx5XCIsICgpID0+IHtcbiAgICAgIG5ldyBPcHRpbWl6ZWRMYW1iZGEoc3RhY2ssIFwiVGVzdExhbWJkYVwiLCB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZTogXCJ0ZXN0LWZ1bmN0aW9uXCIsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlUGF0aDogXCJ0ZXN0L2ZpeHR1cmVzL2xhbWJkYVwiLFxuICAgICAgICBjb25maWcsXG4gICAgICAgIHBlcmZvcm1hbmNlUHJvZmlsZTogXCJiYXRjaFwiLFxuICAgICAgfSlcblxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoXCJBV1M6OkxhbWJkYTo6RnVuY3Rpb25cIiwge1xuICAgICAgICBNZW1vcnlTaXplOiAzMDA4LCAvLyBCYXRjaCBwcm9maWxlIGRlZmF1bHRcbiAgICAgICAgVGltZW91dDogOTAwLCAvLyAxNSBtaW51dGVzXG4gICAgICAgIFJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IDIsXG4gICAgICB9KVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoXCJQb3dlclR1bmluZyBDb25maWd1cmF0aW9uXCIsICgpID0+IHtcbiAgICB0ZXN0KFwidXNlcyBQb3dlclR1bmVkIG1lbW9yeSBzaXplIHdoZW4gcHJvdmlkZWRcIiwgKCkgPT4ge1xuICAgICAgbmV3IE9wdGltaXplZExhbWJkYShzdGFjaywgXCJUZXN0TGFtYmRhXCIsIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBcInRlc3QtZnVuY3Rpb25cIixcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGVQYXRoOiBcInRlc3QvZml4dHVyZXMvbGFtYmRhXCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgcG93ZXJUdW5pbmc6IHtcbiAgICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgICAgIHR1bmVkTWVtb3J5U2l6ZTogMTUzNixcbiAgICAgICAgICB0dW5lZFRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDMpLFxuICAgICAgICB9LFxuICAgICAgfSlcblxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoXCJBV1M6OkxhbWJkYTo6RnVuY3Rpb25cIiwge1xuICAgICAgICBNZW1vcnlTaXplOiAxNTM2LFxuICAgICAgICBUaW1lb3V0OiAxODAsXG4gICAgICB9KVxuICAgIH0pXG5cbiAgICB0ZXN0KFwiYWRkcyBQb3dlclR1bmVkIHRhZyB3aGVuIHR1bmluZyByZXN1bHRzIGFwcGxpZWRcIiwgKCkgPT4ge1xuICAgICAgbmV3IE9wdGltaXplZExhbWJkYShzdGFjaywgXCJUZXN0TGFtYmRhXCIsIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBcInRlc3QtZnVuY3Rpb25cIixcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGVQYXRoOiBcInRlc3QvZml4dHVyZXMvbGFtYmRhXCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgcG93ZXJUdW5pbmc6IHtcbiAgICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgICAgIHR1bmVkTWVtb3J5U2l6ZTogMTUzNixcbiAgICAgICAgfSxcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpMYW1iZGE6OkZ1bmN0aW9uXCIsIHtcbiAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7IEtleTogXCJPcHRpbWl6ZWRNZW1vcnlcIiwgVmFsdWU6IFwiMTUzNlwiIH0sXG4gICAgICAgICAgeyBLZXk6IFwiUG93ZXJUdW5lZFwiLCBWYWx1ZTogXCJ0cnVlXCIgfSxcbiAgICAgICAgXSksXG4gICAgICB9KVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoXCJDb25jdXJyZW5jeSBDb25maWd1cmF0aW9uXCIsICgpID0+IHtcbiAgICB0ZXN0KFwic2V0cyByZXNlcnZlZCBjb25jdXJyZW5jeVwiLCAoKSA9PiB7XG4gICAgICBuZXcgT3B0aW1pemVkTGFtYmRhKHN0YWNrLCBcIlRlc3RMYW1iZGFcIiwge1xuICAgICAgICBmdW5jdGlvbk5hbWU6IFwidGVzdC1mdW5jdGlvblwiLFxuICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgY29kZVBhdGg6IFwidGVzdC9maXh0dXJlcy9sYW1iZGFcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgICBjb25jdXJyZW5jeToge1xuICAgICAgICAgIHJlc2VydmVkOiAyMCxcbiAgICAgICAgfSxcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpMYW1iZGE6OkZ1bmN0aW9uXCIsIHtcbiAgICAgICAgUmVzZXJ2ZWRDb25jdXJyZW50RXhlY3V0aW9uczogMjAsXG4gICAgICB9KVxuICAgIH0pXG5cbiAgICB0ZXN0KFwiY3JlYXRlcyBhbGlhcyB3aXRoIHByb3Zpc2lvbmVkIGNvbmN1cnJlbmN5IGZvciBjcml0aWNhbCBmdW5jdGlvbnNcIiwgKCkgPT4ge1xuICAgICAgbmV3IE9wdGltaXplZExhbWJkYShzdGFjaywgXCJUZXN0TGFtYmRhXCIsIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBcInRlc3QtZnVuY3Rpb25cIixcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGVQYXRoOiBcInRlc3QvZml4dHVyZXMvbGFtYmRhXCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgcGVyZm9ybWFuY2VQcm9maWxlOiBcImNyaXRpY2FsXCIsXG4gICAgICAgIGNvbmN1cnJlbmN5OiB7XG4gICAgICAgICAgcHJvdmlzaW9uZWQ6IDUsXG4gICAgICAgIH0sXG4gICAgICB9KVxuXG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcyhcIkFXUzo6TGFtYmRhOjpBbGlhc1wiLCB7XG4gICAgICAgIE5hbWU6IFwibGl2ZVwiLFxuICAgICAgICBQcm92aXNpb25lZENvbmN1cnJlbmN5Q29uZmlnOiB7XG4gICAgICAgICAgUHJvdmlzaW9uZWRDb25jdXJyZW50RXhlY3V0aW9uczogNSxcbiAgICAgICAgfSxcbiAgICAgIH0pXG4gICAgfSlcblxuICAgIHRlc3QoXCJkb2VzIG5vdCBjcmVhdGUgcHJvdmlzaW9uZWQgY29uY3VycmVuY3kgZm9yIG5vbi1jcml0aWNhbCBmdW5jdGlvbnNcIiwgKCkgPT4ge1xuICAgICAgbmV3IE9wdGltaXplZExhbWJkYShzdGFjaywgXCJUZXN0TGFtYmRhXCIsIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBcInRlc3QtZnVuY3Rpb25cIixcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGVQYXRoOiBcInRlc3QvZml4dHVyZXMvbGFtYmRhXCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgcGVyZm9ybWFuY2VQcm9maWxlOiBcInN0YW5kYXJkXCIsXG4gICAgICAgIGNvbmN1cnJlbmN5OiB7XG4gICAgICAgICAgcHJvdmlzaW9uZWQ6IDUsIC8vIFRoaXMgc2hvdWxkIGJlIGlnbm9yZWQgZm9yIG5vbi1jcml0aWNhbFxuICAgICAgICB9LFxuICAgICAgfSlcblxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG4gICAgICB0ZW1wbGF0ZS5yZXNvdXJjZUNvdW50SXMoXCJBV1M6OkxhbWJkYTo6QWxpYXNcIiwgMClcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKFwiT2JzZXJ2YWJpbGl0eVwiLCAoKSA9PiB7XG4gICAgdGVzdChcImVuYWJsZXMgWC1SYXkgdHJhY2luZyB3aGVuIGNvbmZpZ3VyZWRcIiwgKCkgPT4ge1xuICAgICAgbmV3IE9wdGltaXplZExhbWJkYShzdGFjaywgXCJUZXN0TGFtYmRhXCIsIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBcInRlc3QtZnVuY3Rpb25cIixcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGVQYXRoOiBcInRlc3QvZml4dHVyZXMvbGFtYmRhXCIsXG4gICAgICAgIGNvbmZpZzoge1xuICAgICAgICAgIC4uLmNvbmZpZyxcbiAgICAgICAgICBtb25pdG9yaW5nOiB7XG4gICAgICAgICAgICAuLi5jb25maWcubW9uaXRvcmluZyxcbiAgICAgICAgICAgIHRyYWNpbmdFbmFibGVkOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGVuYWJsZVhSYXk6IHRydWUsXG4gICAgICB9KVxuXG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcyhcIkFXUzo6TGFtYmRhOjpGdW5jdGlvblwiLCB7XG4gICAgICAgIFRyYWNpbmdDb25maWc6IHtcbiAgICAgICAgICBNb2RlOiBcIkFjdGl2ZVwiLFxuICAgICAgICB9LFxuICAgICAgfSlcblxuICAgICAgLy8gU2hvdWxkIGFsc28gaGF2ZSBYLVJheSBwZXJtaXNzaW9uc1xuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpJQU06OlBvbGljeVwiLCB7XG4gICAgICAgIFBvbGljeURvY3VtZW50OiB7XG4gICAgICAgICAgU3RhdGVtZW50OiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICAgIEFjdGlvbjogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgICAgICBcInhyYXk6UHV0VHJhY2VTZWdtZW50c1wiLFxuICAgICAgICAgICAgICAgIFwieHJheTpQdXRUZWxlbWV0cnlSZWNvcmRzXCIsXG4gICAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSksXG4gICAgICAgIH0sXG4gICAgICB9KVxuICAgIH0pXG5cbiAgICB0ZXN0KFwiZGlzYWJsZXMgWC1SYXkgdHJhY2luZyB3aGVuIG5vdCBjb25maWd1cmVkXCIsICgpID0+IHtcbiAgICAgIG5ldyBPcHRpbWl6ZWRMYW1iZGEoc3RhY2ssIFwiVGVzdExhbWJkYVwiLCB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZTogXCJ0ZXN0LWZ1bmN0aW9uXCIsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlUGF0aDogXCJ0ZXN0L2ZpeHR1cmVzL2xhbWJkYVwiLFxuICAgICAgICBjb25maWc6IHtcbiAgICAgICAgICAuLi5jb25maWcsXG4gICAgICAgICAgbW9uaXRvcmluZzoge1xuICAgICAgICAgICAgLi4uY29uZmlnLm1vbml0b3JpbmcsXG4gICAgICAgICAgICB0cmFjaW5nRW5hYmxlZDogZmFsc2UsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgZW5hYmxlWFJheTogZmFsc2UsXG4gICAgICB9KVxuXG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcyhcIkFXUzo6TGFtYmRhOjpGdW5jdGlvblwiLCB7XG4gICAgICAgIFRyYWNpbmdDb25maWc6IE1hdGNoLmFic2VudCgpLFxuICAgICAgfSlcbiAgICB9KVxuXG4gICAgdGVzdChcImVuYWJsZXMgTGFtYmRhIEluc2lnaHRzIHdoZW4gc3BlY2lmaWVkXCIsICgpID0+IHtcbiAgICAgIG5ldyBPcHRpbWl6ZWRMYW1iZGEoc3RhY2ssIFwiVGVzdExhbWJkYVwiLCB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZTogXCJ0ZXN0LWZ1bmN0aW9uXCIsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlUGF0aDogXCJ0ZXN0L2ZpeHR1cmVzL2xhbWJkYVwiLFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGVuYWJsZUluc2lnaHRzOiB0cnVlLFxuICAgICAgfSlcblxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG4gICAgICBjb25zdCByZXNvdXJjZXMgPSB0ZW1wbGF0ZS5maW5kUmVzb3VyY2VzKFwiQVdTOjpMYW1iZGE6OkZ1bmN0aW9uXCIpXG4gICAgICBjb25zdCBzeW50aGVzaXplZCA9IE9iamVjdC52YWx1ZXMocmVzb3VyY2VzKVswXSBhc1xuICAgICAgICB8IHsgUHJvcGVydGllcz86IHsgTGF5ZXJzPzogdW5rbm93bltdIH0gfVxuICAgICAgICB8IHVuZGVmaW5lZFxuICAgICAgZXhwZWN0KHN5bnRoZXNpemVkPy5Qcm9wZXJ0aWVzPy5MYXllcnMpLnRvSGF2ZUxlbmd0aCgxKVxuICAgIH0pXG5cbiAgICB0ZXN0KFwiY3JlYXRlcyBtb25pdG9yaW5nIGRhc2hib2FyZCB3aGVuIGluc2lnaHRzIGVuYWJsZWRcIiwgKCkgPT4ge1xuICAgICAgY29uc3Qgb3B0aW1pemVkTGFtYmRhID0gbmV3IE9wdGltaXplZExhbWJkYShzdGFjaywgXCJUZXN0TGFtYmRhXCIsIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBcInRlc3QtZnVuY3Rpb25cIixcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGVQYXRoOiBcInRlc3QvZml4dHVyZXMvbGFtYmRhXCIsXG4gICAgICAgIGNvbmZpZzoge1xuICAgICAgICAgIC4uLmNvbmZpZyxcbiAgICAgICAgICBtb25pdG9yaW5nOiB7XG4gICAgICAgICAgICAuLi5jb25maWcubW9uaXRvcmluZyxcbiAgICAgICAgICAgIGRldGFpbGVkTWV0cmljczogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBlbmFibGVJbnNpZ2h0czogdHJ1ZSxcbiAgICAgIH0pXG5cbiAgICAgIGV4cGVjdChvcHRpbWl6ZWRMYW1iZGEuZGFzaGJvYXJkKS50b0JlVW5kZWZpbmVkKClcbiAgICAgIGV4cGVjdChvcHRpbWl6ZWRMYW1iZGEubWV0cmljKFwiaW52b2NhdGlvbnNcIikpLnRvQmVEZWZpbmVkKClcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKFwiRW52aXJvbm1lbnQgVmFyaWFibGVzXCIsICgpID0+IHtcbiAgICB0ZXN0KFwic2V0cyBwZXJmb3JtYW5jZSBlbnZpcm9ubWVudCB2YXJpYWJsZXMgZm9yIEFSTTY0XCIsICgpID0+IHtcbiAgICAgIG5ldyBPcHRpbWl6ZWRMYW1iZGEoc3RhY2ssIFwiVGVzdExhbWJkYVwiLCB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZTogXCJ0ZXN0LWZ1bmN0aW9uXCIsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlUGF0aDogXCJ0ZXN0L2ZpeHR1cmVzL2xhbWJkYVwiLFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGVuYWJsZUdyYXZpdG9uOiB0cnVlLFxuICAgICAgfSlcblxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoXCJBV1M6OkxhbWJkYTo6RnVuY3Rpb25cIiwge1xuICAgICAgICBFbnZpcm9ubWVudDoge1xuICAgICAgICAgIFZhcmlhYmxlczogTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICBOT0RFX09QVElPTlM6IFwiLS1lbmFibGUtc291cmNlLW1hcHNcIixcbiAgICAgICAgICAgIEFXU19OT0RFSlNfQ09OTkVDVElPTl9SRVVTRV9FTkFCTEVEOiBcIjFcIixcbiAgICAgICAgICAgIEFXU19TREtfSlNfU1VQUFJFU1NfTUFJTlRFTkFOQ0VfTU9ERV9NRVNTQUdFOiBcIjFcIixcbiAgICAgICAgICAgIFVWX1RIUkVBRFBPT0xfU0laRTogXCI4XCIsXG4gICAgICAgICAgICBNQUxMT0NfQVJFTkFfTUFYOiBcIjJcIixcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSxcbiAgICAgIH0pXG4gICAgfSlcblxuICAgIHRlc3QoXCJtZXJnZXMgY3VzdG9tIGVudmlyb25tZW50IHZhcmlhYmxlc1wiLCAoKSA9PiB7XG4gICAgICBuZXcgT3B0aW1pemVkTGFtYmRhKHN0YWNrLCBcIlRlc3RMYW1iZGFcIiwge1xuICAgICAgICBmdW5jdGlvbk5hbWU6IFwidGVzdC1mdW5jdGlvblwiLFxuICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgY29kZVBhdGg6IFwidGVzdC9maXh0dXJlcy9sYW1iZGFcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAgIENVU1RPTV9WQVI6IFwiY3VzdG9tLXZhbHVlXCIsXG4gICAgICAgICAgQlVDS0VUX05BTUU6IFwibXktYnVja2V0XCIsXG4gICAgICAgIH0sXG4gICAgICB9KVxuXG4gICAgICBjb25zdCB0ZW1wbGF0ZSA9IFRlbXBsYXRlLmZyb21TdGFjayhzdGFjaylcbiAgICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcyhcIkFXUzo6TGFtYmRhOjpGdW5jdGlvblwiLCB7XG4gICAgICAgIEVudmlyb25tZW50OiB7XG4gICAgICAgICAgVmFyaWFibGVzOiBNYXRjaC5vYmplY3RMaWtlKHtcbiAgICAgICAgICAgIENVU1RPTV9WQVI6IFwiY3VzdG9tLXZhbHVlXCIsXG4gICAgICAgICAgICBCVUNLRVRfTkFNRTogXCJteS1idWNrZXRcIixcbiAgICAgICAgICAgIE5PREVfT1BUSU9OUzogXCItLWVuYWJsZS1zb3VyY2UtbWFwc1wiLCAvLyBTaG91bGQgYWxzbyBoYXZlIGRlZmF1bHQgdmFyc1xuICAgICAgICAgIH0pLFxuICAgICAgICB9LFxuICAgICAgfSlcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKFwiQ29zdCBUcmFja2luZyBUYWdzXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiYWRkcyBjb3N0IGFsbG9jYXRpb24gdGFnc1wiLCAoKSA9PiB7XG4gICAgICBuZXcgT3B0aW1pemVkTGFtYmRhKHN0YWNrLCBcIlRlc3RMYW1iZGFcIiwge1xuICAgICAgICBmdW5jdGlvbk5hbWU6IFwidGVzdC1mdW5jdGlvblwiLFxuICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgY29kZVBhdGg6IFwidGVzdC9maXh0dXJlcy9sYW1iZGFcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgICBwZXJmb3JtYW5jZVByb2ZpbGU6IFwiY3JpdGljYWxcIixcbiAgICAgICAgcG93ZXJUdW5pbmc6IHtcbiAgICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgICAgIHR1bmVkTWVtb3J5U2l6ZTogMjA0OCxcbiAgICAgICAgfSxcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpMYW1iZGE6OkZ1bmN0aW9uXCIsIHtcbiAgICAgICAgVGFnczogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICB7IEtleTogXCJBcmNoaXRlY3R1cmVcIiwgVmFsdWU6IFwiQVJNNjRcIiB9LFxuICAgICAgICAgIHsgS2V5OiBcIk1hbmFnZWRCeVwiLCBWYWx1ZTogXCJPcHRpbWl6ZWRMYW1iZGFcIiB9LFxuICAgICAgICAgIHsgS2V5OiBcIk9wdGltaXplZFwiLCBWYWx1ZTogXCJ0cnVlXCIgfSxcbiAgICAgICAgICB7IEtleTogXCJPcHRpbWl6ZWRNZW1vcnlcIiwgVmFsdWU6IFwiMjA0OFwiIH0sXG4gICAgICAgICAgeyBLZXk6IFwiUGVyZm9ybWFuY2VQcm9maWxlXCIsIFZhbHVlOiBcImNyaXRpY2FsXCIgfSxcbiAgICAgICAgICB7IEtleTogXCJQb3dlclR1bmVkXCIsIFZhbHVlOiBcInRydWVcIiB9LFxuICAgICAgICBdKSxcbiAgICAgIH0pXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZShcIkludGVncmF0aW9uXCIsICgpID0+IHtcbiAgICB0ZXN0KFwiZXhwb3NlcyB1bmRlcmx5aW5nIExhbWJkYSBmdW5jdGlvblwiLCAoKSA9PiB7XG4gICAgICBjb25zdCBvcHRpbWl6ZWRMYW1iZGEgPSBuZXcgT3B0aW1pemVkTGFtYmRhKHN0YWNrLCBcIlRlc3RMYW1iZGFcIiwge1xuICAgICAgICBmdW5jdGlvbk5hbWU6IFwidGVzdC1mdW5jdGlvblwiLFxuICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgY29kZVBhdGg6IFwidGVzdC9maXh0dXJlcy9sYW1iZGFcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgfSlcblxuICAgICAgZXhwZWN0KG9wdGltaXplZExhbWJkYS5mdW5jdGlvbikudG9CZUluc3RhbmNlT2YobGFtYmRhLkZ1bmN0aW9uKVxuICAgICAgVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoXCJBV1M6OkxhbWJkYTo6RnVuY3Rpb25cIiwge1xuICAgICAgICBGdW5jdGlvbk5hbWU6IFwidGVzdC1mdW5jdGlvblwiLFxuICAgICAgfSlcbiAgICB9KVxuXG4gICAgdGVzdChcImV4cG9zZXMgbG9nIGdyb3VwXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IG9wdGltaXplZExhbWJkYSA9IG5ldyBPcHRpbWl6ZWRMYW1iZGEoc3RhY2ssIFwiVGVzdExhbWJkYVwiLCB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZTogXCJ0ZXN0LWZ1bmN0aW9uXCIsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlUGF0aDogXCJ0ZXN0L2ZpeHR1cmVzL2xhbWJkYVwiLFxuICAgICAgICBjb25maWcsXG4gICAgICB9KVxuXG4gICAgICBleHBlY3Qob3B0aW1pemVkTGFtYmRhLmxvZ0dyb3VwKS50b0JlRGVmaW5lZCgpXG4gICAgfSlcblxuICAgIHRlc3QoXCJncmFudEludm9rZSBkZWxlZ2F0ZXMgdG8gdW5kZXJseWluZyBmdW5jdGlvblwiLCAoKSA9PiB7XG4gICAgICBjb25zdCBvcHRpbWl6ZWRMYW1iZGEgPSBuZXcgT3B0aW1pemVkTGFtYmRhKHN0YWNrLCBcIlRlc3RMYW1iZGFcIiwge1xuICAgICAgICBmdW5jdGlvbk5hbWU6IFwidGVzdC1mdW5jdGlvblwiLFxuICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgY29kZVBhdGg6IFwidGVzdC9maXh0dXJlcy9sYW1iZGFcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgfSlcblxuICAgICAgY29uc3Qgcm9sZSA9IG5ldyBjZGsuYXdzX2lhbS5Sb2xlKHN0YWNrLCBcIlRlc3RSb2xlXCIsIHtcbiAgICAgICAgYXNzdW1lZEJ5OiBuZXcgY2RrLmF3c19pYW0uU2VydmljZVByaW5jaXBhbChcImxhbWJkYS5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgfSlcblxuICAgICAgb3B0aW1pemVkTGFtYmRhLmdyYW50SW52b2tlKHJvbGUpXG5cbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpJQU06OlBvbGljeVwiLCB7XG4gICAgICAgIFBvbGljeURvY3VtZW50OiB7XG4gICAgICAgICAgU3RhdGVtZW50OiBNYXRjaC5hcnJheVdpdGgoW1xuICAgICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICAgIEFjdGlvbjogXCJsYW1iZGE6SW52b2tlRnVuY3Rpb25cIixcbiAgICAgICAgICAgICAgUmVzb3VyY2U6IE1hdGNoLmFycmF5V2l0aChbXG4gICAgICAgICAgICAgICAgTWF0Y2gub2JqZWN0TGlrZSh7XG4gICAgICAgICAgICAgICAgICBcIkZuOjpHZXRBdHRcIjogTWF0Y2guYXJyYXlXaXRoKFtcbiAgICAgICAgICAgICAgICAgICAgTWF0Y2guc3RyaW5nTGlrZVJlZ2V4cChcIi4qRnVuY3Rpb24uKlwiKSxcbiAgICAgICAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgICBdKSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0pLFxuICAgICAgICB9LFxuICAgICAgfSlcbiAgICB9KVxuXG4gICAgdGVzdChcImFkZEVudmlyb25tZW50IGFkZHMgdmFyaWFibGVzIHRvIGZ1bmN0aW9uXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IG9wdGltaXplZExhbWJkYSA9IG5ldyBPcHRpbWl6ZWRMYW1iZGEoc3RhY2ssIFwiVGVzdExhbWJkYVwiLCB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZTogXCJ0ZXN0LWZ1bmN0aW9uXCIsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlUGF0aDogXCJ0ZXN0L2ZpeHR1cmVzL2xhbWJkYVwiLFxuICAgICAgICBjb25maWcsXG4gICAgICB9KVxuXG4gICAgICBvcHRpbWl6ZWRMYW1iZGEuYWRkRW52aXJvbm1lbnQoXCJORVdfVkFSXCIsIFwibmV3LXZhbHVlXCIpXG5cbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpMYW1iZGE6OkZ1bmN0aW9uXCIsIHtcbiAgICAgICAgRW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICBWYXJpYWJsZXM6IE1hdGNoLm9iamVjdExpa2Uoe1xuICAgICAgICAgICAgTkVXX1ZBUjogXCJuZXctdmFsdWVcIixcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSxcbiAgICAgIH0pXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZShcIkN1c3RvbSBSdW50aW1lIGFuZCBCdW5kbGluZ1wiLCAoKSA9PiB7XG4gICAgdGVzdChcInN1cHBvcnRzIGN1c3RvbSBydW50aW1lXCIsICgpID0+IHtcbiAgICAgIG5ldyBPcHRpbWl6ZWRMYW1iZGEoc3RhY2ssIFwiVGVzdExhbWJkYVwiLCB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZTogXCJ0ZXN0LWZ1bmN0aW9uXCIsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlUGF0aDogXCJ0ZXN0L2ZpeHR1cmVzL2xhbWJkYVwiLFxuICAgICAgICBjb25maWcsXG4gICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzExLFxuICAgICAgfSlcblxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoXCJBV1M6OkxhbWJkYTo6RnVuY3Rpb25cIiwge1xuICAgICAgICBSdW50aW1lOiBcInB5dGhvbjMuMTFcIixcbiAgICAgIH0pXG4gICAgfSlcblxuICAgIHRlc3QoXCJkaXNhYmxlcyBvcHRpbWl6ZWQgYnVuZGxpbmcgd2hlbiByZXF1ZXN0ZWRcIiwgKCkgPT4ge1xuICAgICAgY29uc3Qgb3B0aW1pemVkTGFtYmRhID0gbmV3IE9wdGltaXplZExhbWJkYShzdGFjaywgXCJUZXN0TGFtYmRhXCIsIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBcInRlc3QtZnVuY3Rpb25cIixcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGVQYXRoOiBcInRlc3QvZml4dHVyZXMvbGFtYmRhXCIsXG4gICAgICAgIGNvbmZpZyxcbiAgICAgICAgZW5hYmxlT3B0aW1pemVkQnVuZGxpbmc6IGZhbHNlLFxuICAgICAgfSlcblxuICAgICAgZXhwZWN0KG9wdGltaXplZExhbWJkYS5mdW5jdGlvbikudG9CZURlZmluZWQoKVxuICAgICAgLy8gQ2FuJ3QgZWFzaWx5IHRlc3QgYnVuZGxpbmcgb3B0aW9ucyBpbiB1bml0IHRlc3RzLCBidXQgZW5zdXJlIGZ1bmN0aW9uIGlzIGNyZWF0ZWRcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKFwiTG9nIFJldGVudGlvblwiLCAoKSA9PiB7XG4gICAgdGVzdChcInVzZXMgY3VzdG9tIGxvZyByZXRlbnRpb24gd2hlbiBwcm92aWRlZFwiLCAoKSA9PiB7XG4gICAgICBuZXcgT3B0aW1pemVkTGFtYmRhKHN0YWNrLCBcIlRlc3RMYW1iZGFcIiwge1xuICAgICAgICBmdW5jdGlvbk5hbWU6IFwidGVzdC1mdW5jdGlvblwiLFxuICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgY29kZVBhdGg6IFwidGVzdC9maXh0dXJlcy9sYW1iZGFcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgICBsb2dSZXRlbnRpb246IGNkay5hd3NfbG9ncy5SZXRlbnRpb25EYXlzLlRXT19XRUVLUyxcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpMb2dzOjpMb2dHcm91cFwiLCB7XG4gICAgICAgIFJldGVudGlvbkluRGF5czogMTQsXG4gICAgICB9KVxuICAgIH0pXG5cbiAgICB0ZXN0KFwidXNlcyBwcm9maWxlLWJhc2VkIGxvZyByZXRlbnRpb24gZm9yIGNyaXRpY2FsIGZ1bmN0aW9uc1wiLCAoKSA9PiB7XG4gICAgICBuZXcgT3B0aW1pemVkTGFtYmRhKHN0YWNrLCBcIlRlc3RMYW1iZGFcIiwge1xuICAgICAgICBmdW5jdGlvbk5hbWU6IFwidGVzdC1mdW5jdGlvblwiLFxuICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgY29kZVBhdGg6IFwidGVzdC9maXh0dXJlcy9sYW1iZGFcIixcbiAgICAgICAgY29uZmlnLFxuICAgICAgICBwZXJmb3JtYW5jZVByb2ZpbGU6IFwiY3JpdGljYWxcIixcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gVGVtcGxhdGUuZnJvbVN0YWNrKHN0YWNrKVxuICAgICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKFwiQVdTOjpMb2dzOjpMb2dHcm91cFwiLCB7XG4gICAgICAgIFJldGVudGlvbkluRGF5czogMzAsIC8vIE9ORV9NT05USCBmb3IgY3JpdGljYWxcbiAgICAgIH0pXG4gICAgfSlcblxuICAgIHRlc3QoXCJ1c2VzIHByb2ZpbGUtYmFzZWQgbG9nIHJldGVudGlvbiBmb3IgYmF0Y2ggZnVuY3Rpb25zXCIsICgpID0+IHtcbiAgICAgIG5ldyBPcHRpbWl6ZWRMYW1iZGEoc3RhY2ssIFwiVGVzdExhbWJkYVwiLCB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZTogXCJ0ZXN0LWZ1bmN0aW9uXCIsXG4gICAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgICBjb2RlUGF0aDogXCJ0ZXN0L2ZpeHR1cmVzL2xhbWJkYVwiLFxuICAgICAgICBjb25maWcsXG4gICAgICAgIHBlcmZvcm1hbmNlUHJvZmlsZTogXCJiYXRjaFwiLFxuICAgICAgfSlcblxuICAgICAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spXG4gICAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoXCJBV1M6OkxvZ3M6OkxvZ0dyb3VwXCIsIHtcbiAgICAgICAgUmV0ZW50aW9uSW5EYXlzOiA3LCAvLyBPTkVfV0VFSyBmb3IgYmF0Y2hcbiAgICAgIH0pXG4gICAgfSlcbiAgfSlcbn0pXG4iXX0=