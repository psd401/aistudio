import * as cdk from "aws-cdk-lib"
import * as sfn from "aws-cdk-lib/aws-stepfunctions"
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as iam from "aws-cdk-lib/aws-iam"
import * as logs from "aws-cdk-lib/aws-logs"
import { Construct } from "constructs"

export interface PowerTuningStateMachineProps {
  /** Environment (dev, prod, staging) */
  environment: string
  /** Custom log retention */
  logRetention?: logs.RetentionDays
  /** State machine timeout */
  timeout?: cdk.Duration
}

/**
 * AWS Lambda PowerTuning State Machine
 *
 * Automatically finds the optimal memory/power configuration for Lambda functions
 * by executing the function across a range of memory settings and analyzing:
 * - Execution time
 * - Cost
 * - Power (memory/time ratio)
 *
 * Based on: https://github.com/alexcasalboni/aws-lambda-power-tuning
 *
 * Usage:
 * ```typescript
 * const powerTuning = new PowerTuningStateMachine(this, 'PowerTuning', {
 *   environment: 'dev',
 * });
 *
 * // Execute via AWS CLI or SDK:
 * // aws stepfunctions start-execution \
 * //   --state-machine-arn <arn> \
 * //   --input '{
 * //     "lambdaARN": "arn:aws:lambda:region:account:function:my-function",
 * //     "powerValues": [128, 256, 512, 1024, 1536, 2048, 3008],
 * //     "num": 10,
 * //     "payload": {}
 * //   }'
 * ```
 *
 * Part of: Epic #372 - CDK Infrastructure Optimization
 * Based on: ADR-005 - Lambda Function Comprehensive Optimization
 */
export class PowerTuningStateMachine extends Construct {
  public readonly stateMachine: sfn.StateMachine
  public readonly logGroup: logs.LogGroup

  /**
   * Create explicit Lambda role to avoid CDK's deprecated fromAwsManagedPolicyName
   */
  private createLambdaRole(id: string): iam.Role {
    return new iam.Role(this, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          `${id}LambdaBasicExecPolicy`,
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    })
  }

  constructor(
    scope: Construct,
    id: string,
    props: PowerTuningStateMachineProps
  ) {
    super(scope, id)

    // Create log group for State Machine execution logs
    this.logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/aws/states/lambda-power-tuning-${props.environment}`,
      retention: props.logRetention || logs.RetentionDays.ONE_WEEK,
      removalPolicy:
        props.environment === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    })

    // Initializer Lambda - Prepares power tuning execution
    const initializerFunction = this.createInitializerFunction(props)

    // Executor Lambda - Executes target function with different memory configurations
    const executorFunction = this.createExecutorFunction(props)

    // Cleaner Lambda - Cleans up any temporary resources
    const cleanerFunction = this.createCleanerFunction(props)

    // Analyzer Lambda - Analyzes results and determines optimal configuration
    const analyzerFunction = this.createAnalyzerFunction(props)

    // Optimizer Lambda - Applies optimal configuration to target function
    const optimizerFunction = this.createOptimizerFunction(props)

    // Build State Machine definition
    const definition = this.buildStateMachine(
      initializerFunction,
      executorFunction,
      cleanerFunction,
      analyzerFunction,
      optimizerFunction
    )

    // Create State Machine
    this.stateMachine = new sfn.StateMachine(this, "StateMachine", {
      stateMachineName: `lambda-power-tuning-${props.environment}`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: props.timeout || cdk.Duration.hours(1),
      tracingEnabled: props.environment !== "dev",
      logs: {
        destination: this.logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    })

    // Output State Machine ARN
    new cdk.CfnOutput(this, "StateMachineArn", {
      value: this.stateMachine.stateMachineArn,
      description: "Lambda PowerTuning State Machine ARN",
      exportName: `${props.environment}-PowerTuningStateMachineArn`,
    })
  }

  /**
   * Create Initializer Lambda function
   */
  private createInitializerFunction(
    props: PowerTuningStateMachineProps
  ): lambda.Function {
    // Create log group for initializer function
    const initializerLogGroup = new logs.LogGroup(this, "InitializerLogGroup", {
      logGroupName: `/aws/lambda/power-tuning-initializer-${props.environment}`,
      retention: props.logRetention || logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // Add tags for cost tracking
    cdk.Tags.of(initializerLogGroup).add("Environment", props.environment)
    cdk.Tags.of(initializerLogGroup).add("CostCenter", "Compute")
    cdk.Tags.of(initializerLogGroup).add("Component", "PowerTuning")
    cdk.Tags.of(initializerLogGroup).add("ManagedBy", "CDK")

    const fn = new lambda.Function(this, "Initializer", {
      functionName: `power-tuning-initializer-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      role: this.createLambdaRole("Initializer"),
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          const {
            lambdaARN,
            powerValues = [128, 256, 512, 1024, 1536, 2048, 3008, 5120, 10240],
            num = 10,
            payload = {},
            parallelInvocation = false,
            strategy = 'balanced'
          } = event;

          if (!lambdaARN) {
            throw new Error('lambdaARN is required');
          }

          console.log('Initializing PowerTuning', {
            lambdaARN,
            powerValues,
            num,
            strategy
          });

          return {
            lambdaARN,
            powerValues,
            num,
            payload,
            parallelInvocation,
            strategy,
            value: powerValues
          };
        };
      `),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      architecture: lambda.Architecture.ARM_64,
      environment: {
        ENVIRONMENT: props.environment,
      },
      logGroup: initializerLogGroup,
    })

    return fn
  }

  /**
   * Create Executor Lambda function
   */
  private createExecutorFunction(
    props: PowerTuningStateMachineProps
  ): lambda.Function {
    // Create log group for executor function
    const executorLogGroup = new logs.LogGroup(this, "ExecutorLogGroup", {
      logGroupName: `/aws/lambda/power-tuning-executor-${props.environment}`,
      retention: props.logRetention || logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // Add tags for cost tracking
    cdk.Tags.of(executorLogGroup).add("Environment", props.environment)
    cdk.Tags.of(executorLogGroup).add("CostCenter", "Compute")
    cdk.Tags.of(executorLogGroup).add("Component", "PowerTuning")
    cdk.Tags.of(executorLogGroup).add("ManagedBy", "CDK")

    const fn = new lambda.Function(this, "Executor", {
      functionName: `power-tuning-executor-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      role: this.createLambdaRole("Executor"),
      code: lambda.Code.fromInline(`
        const { LambdaClient, InvokeCommand, UpdateFunctionConfigurationCommand, GetFunctionConfigurationCommand } = require('@aws-sdk/client-lambda');
        const lambda = new LambdaClient({});

        exports.handler = async (event) => {
          const { lambdaARN, value: memorySize, num, payload, parallelInvocation } = event;

          console.log('Executing with memory:', memorySize, 'MB');

          // Get current configuration
          const currentConfig = await lambda.send(new GetFunctionConfigurationCommand({
            FunctionName: lambdaARN
          }));

          const originalMemory = currentConfig.MemorySize;

          try {
            // Update function memory if different
            if (originalMemory !== memorySize) {
              await lambda.send(new UpdateFunctionConfigurationCommand({
                FunctionName: lambdaARN,
                MemorySize: memorySize
              }));

              // Wait for update to complete by polling function state
              let attempts = 0;
              const maxAttempts = 60; // 60 attempts * 2s = 2 minutes max wait
              while (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
                const config = await lambda.send(new GetFunctionConfigurationCommand({
                  FunctionName: lambdaARN
                }));

                // Check if update is complete
                if (config.State === 'Active' && config.LastUpdateStatus === 'Successful') {
                  console.log('Function update completed successfully');
                  break;
                }

                if (config.LastUpdateStatus === 'Failed') {
                  throw new Error('Function update failed: ' + config.LastUpdateStatusReason);
                }

                attempts++;
                console.log('Waiting for function update... (attempt ' + attempts + '/' + maxAttempts + ', state: ' + config.State + ', status: ' + config.LastUpdateStatus + ')');
              }

              if (attempts >= maxAttempts) {
                throw new Error('Timeout waiting for function update to complete');
              }
            }

            // Execute function multiple times
            const results = [];
            const startTime = Date.now();

            for (let i = 0; i < num; i++) {
              const invokeStart = Date.now();
              const response = await lambda.send(new InvokeCommand({
                FunctionName: lambdaARN,
                Payload: JSON.stringify(payload),
                LogType: 'Tail'
              }));
              const invokeEnd = Date.now();

              const duration = invokeEnd - invokeStart;
              const billedDuration = Math.ceil(duration / 100) * 100; // Round up to nearest 100ms

              results.push({
                duration,
                billedDuration,
                statusCode: response.StatusCode,
                error: response.FunctionError
              });
            }

            const totalTime = Date.now() - startTime;
            const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;
            const avgBilledDuration = results.reduce((sum, r) => sum + r.billedDuration, 0) / results.length;

            // Calculate cost (GB-seconds * price per GB-second)
            // ARM64: $0.0000133334 per GB-second
            // x86: $0.0000166667 per GB-second
            const isARM = currentConfig.Architectures?.[0] === 'arm64';
            const pricePerGBSecond = isARM ? 0.0000133334 : 0.0000166667;
            const gbSeconds = (memorySize / 1024) * (avgBilledDuration / 1000);
            const costPerInvocation = gbSeconds * pricePerGBSecond;
            const totalCost = costPerInvocation * num;

            console.log('Execution complete:', {
              memorySize,
              avgDuration,
              avgBilledDuration,
              costPerInvocation,
              totalCost
            });

            return {
              value: memorySize,
              memorySize,
              avgDuration,
              avgBilledDuration,
              costPerInvocation,
              totalCost,
              results,
              totalTime,
              architecture: isARM ? 'arm64' : 'x86_64'
            };
          } finally {
            // Restore original memory if changed
            if (originalMemory !== memorySize) {
              console.log('Restoring original memory: ' + originalMemory + 'MB');
              await lambda.send(new UpdateFunctionConfigurationCommand({
                FunctionName: lambdaARN,
                MemorySize: originalMemory
              }));

              // Wait for restore to complete
              let attempts = 0;
              const maxAttempts = 60;
              while (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                const config = await lambda.send(new GetFunctionConfigurationCommand({
                  FunctionName: lambdaARN
                }));

                if (config.State === 'Active' && config.LastUpdateStatus === 'Successful') {
                  console.log('Function restored successfully');
                  break;
                }

                attempts++;
              }
            }
          }
        };
      `),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      architecture: lambda.Architecture.ARM_64,
      environment: {
        ENVIRONMENT: props.environment,
      },
      logGroup: executorLogGroup,
    })

    // Grant permission to invoke and update target functions
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "lambda:InvokeFunction",
          "lambda:UpdateFunctionConfiguration",
          "lambda:GetFunctionConfiguration",
        ],
        resources: ["*"], // Will be limited to functions in same account
      })
    )

    return fn
  }

  /**
   * Create Cleaner Lambda function
   */
  private createCleanerFunction(
    props: PowerTuningStateMachineProps
  ): lambda.Function {
    // Create log group for cleaner function
    const cleanerLogGroup = new logs.LogGroup(this, "CleanerLogGroup", {
      logGroupName: `/aws/lambda/power-tuning-cleaner-${props.environment}`,
      retention: props.logRetention || logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // Add tags for cost tracking
    cdk.Tags.of(cleanerLogGroup).add("Environment", props.environment)
    cdk.Tags.of(cleanerLogGroup).add("CostCenter", "Compute")
    cdk.Tags.of(cleanerLogGroup).add("Component", "PowerTuning")
    cdk.Tags.of(cleanerLogGroup).add("ManagedBy", "CDK")

    const fn = new lambda.Function(this, "Cleaner", {
      functionName: `power-tuning-cleaner-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      role: this.createLambdaRole("Cleaner"),
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.log('Cleaning up resources');
          // Cleanup logic if needed
          return { status: 'cleaned' };
        };
      `),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      architecture: lambda.Architecture.ARM_64,
      logGroup: cleanerLogGroup,
    })

    return fn
  }

  /**
   * Create Analyzer Lambda function
   */
  private createAnalyzerFunction(
    props: PowerTuningStateMachineProps
  ): lambda.Function {
    // Create log group for analyzer function
    const analyzerLogGroup = new logs.LogGroup(this, "AnalyzerLogGroup", {
      logGroupName: `/aws/lambda/power-tuning-analyzer-${props.environment}`,
      retention: props.logRetention || logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // Add tags for cost tracking
    cdk.Tags.of(analyzerLogGroup).add("Environment", props.environment)
    cdk.Tags.of(analyzerLogGroup).add("CostCenter", "Compute")
    cdk.Tags.of(analyzerLogGroup).add("Component", "PowerTuning")
    cdk.Tags.of(analyzerLogGroup).add("ManagedBy", "CDK")

    const fn = new lambda.Function(this, "Analyzer", {
      functionName: `power-tuning-analyzer-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      role: this.createLambdaRole("Analyzer"),
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          const { strategy = 'balanced' } = event;
          const results = event.results || [];

          console.log('Analyzing results for strategy:', strategy);

          if (!results.length) {
            throw new Error('No results to analyze');
          }

          let optimalConfig;

          switch (strategy) {
            case 'cost':
              // Minimize cost
              optimalConfig = results.reduce((min, curr) =>
                curr.costPerInvocation < min.costPerInvocation ? curr : min
              );
              break;

            case 'speed':
              // Minimize duration
              optimalConfig = results.reduce((min, curr) =>
                curr.avgDuration < min.avgDuration ? curr : min
              );
              break;

            case 'balanced':
            default:
              // Balance cost and performance using cost-performance score
              // Score = (normalized_cost + normalized_duration) / 2
              const maxCost = Math.max(...results.map(r => r.costPerInvocation));
              const maxDuration = Math.max(...results.map(r => r.avgDuration));
              const minCost = Math.min(...results.map(r => r.costPerInvocation));
              const minDuration = Math.min(...results.map(r => r.avgDuration));

              const scored = results.map(r => ({
                ...r,
                score: (
                  ((r.costPerInvocation - minCost) / (maxCost - minCost)) * 0.4 +
                  ((r.avgDuration - minDuration) / (maxDuration - minDuration)) * 0.6
                )
              }));

              optimalConfig = scored.reduce((min, curr) =>
                curr.score < min.score ? curr : min
              );
              break;
          }

          console.log('Optimal configuration:', {
            memorySize: optimalConfig.memorySize,
            avgDuration: optimalConfig.avgDuration,
            costPerInvocation: optimalConfig.costPerInvocation
          });

          return {
            optimal: optimalConfig,
            allResults: results,
            strategy,
            savings: {
              cost: results[0].costPerInvocation - optimalConfig.costPerInvocation,
              duration: results[0].avgDuration - optimalConfig.avgDuration
            }
          };
        };
      `),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      architecture: lambda.Architecture.ARM_64,
      logGroup: analyzerLogGroup,
    })

    return fn
  }

  /**
   * Create Optimizer Lambda function
   */
  private createOptimizerFunction(
    props: PowerTuningStateMachineProps
  ): lambda.Function {
    // Create log group for optimizer function
    const optimizerLogGroup = new logs.LogGroup(this, "OptimizerLogGroup", {
      logGroupName: `/aws/lambda/power-tuning-optimizer-${props.environment}`,
      retention: props.logRetention || logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // Add tags for cost tracking
    cdk.Tags.of(optimizerLogGroup).add("Environment", props.environment)
    cdk.Tags.of(optimizerLogGroup).add("CostCenter", "Compute")
    cdk.Tags.of(optimizerLogGroup).add("Component", "PowerTuning")
    cdk.Tags.of(optimizerLogGroup).add("ManagedBy", "CDK")

    const fn = new lambda.Function(this, "Optimizer", {
      functionName: `power-tuning-optimizer-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      role: this.createLambdaRole("Optimizer"),
      code: lambda.Code.fromInline(`
        const { LambdaClient, UpdateFunctionConfigurationCommand, TagResourceCommand } = require('@aws-sdk/client-lambda');
        const lambda = new LambdaClient({});

        exports.handler = async (event) => {
          const { lambdaARN, optimal, autoApply = false } = event;

          console.log('Optimization recommendation:', {
            memorySize: optimal.memorySize,
            avgDuration: optimal.avgDuration,
            costPerInvocation: optimal.costPerInvocation
          });

          if (autoApply) {
            console.log('Auto-applying optimal configuration');

            await lambda.send(new UpdateFunctionConfigurationCommand({
              FunctionName: lambdaARN,
              MemorySize: optimal.memorySize
            }));

            // Tag function as PowerTuned
            await lambda.send(new TagResourceCommand({
              Resource: lambdaARN,
              Tags: {
                'PowerTuned': 'true',
                'OptimalMemory': String(optimal.memorySize),
                'TunedDate': new Date().toISOString()
              }
            }));

            console.log('Configuration applied successfully');
          }

          return {
            lambdaARN,
            recommendedMemory: optimal.memorySize,
            estimatedDuration: optimal.avgDuration,
            estimatedCost: optimal.costPerInvocation,
            applied: autoApply,
            savings: event.savings
          };
        };
      `),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      architecture: lambda.Architecture.ARM_64,
      logGroup: optimizerLogGroup,
    })

    // Grant permission to update function configuration and tags
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "lambda:UpdateFunctionConfiguration",
          "lambda:TagResource",
        ],
        resources: ["*"],
      })
    )

    return fn
  }

  /**
   * Build State Machine definition
   */
  private buildStateMachine(
    initializer: lambda.Function,
    executor: lambda.Function,
    cleaner: lambda.Function,
    analyzer: lambda.Function,
    optimizer: lambda.Function
  ): sfn.Chain {
    // Initialize task
    const initialize = new tasks.LambdaInvoke(this, "Initialize", {
      lambdaFunction: initializer,
      outputPath: "$.Payload",
    })

    // Map state to execute function with different memory configurations
    // maxConcurrency: 1 ensures sequential execution to avoid conflicts when updating Lambda config
    const executeMap = new sfn.Map(this, "ExecuteConfigurations", {
      itemsPath: "$.value",
      maxConcurrency: 1,
      itemSelector: {
        "lambdaARN.$": "$.lambdaARN",
        "value.$": "$$.Map.Item.Value",
        "num.$": "$.num",
        "payload.$": "$.payload",
        "parallelInvocation.$": "$.parallelInvocation",
      },
      resultPath: "$.results",
    })

    const execute = new tasks.LambdaInvoke(this, "Execute", {
      lambdaFunction: executor,
      outputPath: "$.Payload",
    })

    executeMap.itemProcessor(execute)

    // Clean up
    const clean = new tasks.LambdaInvoke(this, "Clean", {
      lambdaFunction: cleaner,
      resultPath: "$.cleanupResult",
    })

    // Analyze results
    const analyze = new tasks.LambdaInvoke(this, "Analyze", {
      lambdaFunction: analyzer,
      outputPath: "$.Payload",
    })

    // Optimize/Apply configuration
    const optimize = new tasks.LambdaInvoke(this, "Optimize", {
      lambdaFunction: optimizer,
      outputPath: "$.Payload",
    })

    // Build chain
    return initialize
      .next(executeMap)
      .next(clean)
      .next(analyze)
      .next(optimize)
  }
}
