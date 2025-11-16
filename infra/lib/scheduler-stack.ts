import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as path from 'path';
import { VPCProvider, EnvironmentConfig } from './constructs';

export interface SchedulerStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
  // Cross-stack dependencies retrieved from SSM Parameter Store
  databaseResourceArn?: string;
  databaseSecretArn?: string;
}

export class SchedulerStack extends cdk.Stack {
  public readonly scheduleExecutorFunction: lambda.Function;
  public readonly scheduleExecutorRole: iam.Role;
  public readonly schedulerExecutionRole: iam.Role;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: SchedulerStackProps) {
    super(scope, id, props);

    // Retrieve values from SSM Parameter Store (or use provided props for backward compatibility)
    const databaseResourceArn = props.databaseResourceArn ||
      ssm.StringParameter.valueForStringParameter(
        this, `/aistudio/${props.environment}/db-cluster-arn`
      );

    const databaseSecretArn = props.databaseSecretArn ||
      ssm.StringParameter.valueForStringParameter(
        this, `/aistudio/${props.environment}/db-secret-arn`
      );

    // Get environment configuration for VPC
    const config = EnvironmentConfig.get(props.environment);

    // Use shared VPC for Lambda (required to reach internal ECS endpoint)
    const vpc = VPCProvider.getOrCreate(this, props.environment, config);

    // Create security group for Lambda
    const lambdaSg = new ec2.SecurityGroup(this, 'ScheduleExecutorSecurityGroup', {
      vpc,
      description: 'Security group for schedule executor Lambda',
      allowAllOutbound: true, // Required for Lambda to reach ECS ALB and AWS APIs
    });

    // Dead Letter Queue for failed schedule executions
    this.deadLetterQueue = new sqs.Queue(this, 'ScheduleExecutionDLQ', {
      queueName: `aistudio-${props.environment}-schedule-execution-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    // CloudWatch Log Group for scheduler executions
    const scheduleExecutorLogGroup = new logs.LogGroup(this, 'ScheduleExecutorLogGroup', {
      logGroupName: `/aws/lambda/aistudio-${props.environment}-schedule-executor`,
      retention: props.environment === 'prod' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Lambda function for executing scheduled tasks
    // PowerTuning Result (2025-10-24): 2048MB → 512MB (75% reduction)
    this.scheduleExecutorFunction = new lambda.Function(this, 'ScheduleExecutor', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'dist/index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/schedule-executor')),
      functionName: `aistudio-${props.environment}-schedule-executor`,
      timeout: cdk.Duration.minutes(15), // Full Lambda timeout for long-running Assistant Architect executions
      memorySize: 512, // Optimized via PowerTuning from 2GB
      // VPC configuration (required to reach internal ECS endpoint)
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, // Private-Application subnets
      },
      securityGroups: [lambdaSg],
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        DATABASE_RESOURCE_ARN: databaseResourceArn,
        DATABASE_SECRET_ARN: databaseSecretArn,
        DATABASE_NAME: 'aistudio',
        ENVIRONMENT: props.environment,
        DLQ_URL: this.deadLetterQueue.queueUrl,
        // SSM parameter names - Lambda reads actual values at runtime
        ECS_INTERNAL_ENDPOINT_PARAM: `/aistudio/${props.environment}/ecs-internal-endpoint`,
        INTERNAL_API_SECRET_ARN_PARAM: `/aistudio/${props.environment}/internal-api-secret-arn`,
      },
      logGroup: scheduleExecutorLogGroup,
      // Concurrency limits to prevent overwhelming the system
      reservedConcurrentExecutions: props.environment === 'prod' ? 10 : 5,
    });

    // IAM Role for EventBridge Scheduler to invoke Lambda
    this.schedulerExecutionRole = new iam.Role(this, 'SchedulerExecutionRole', {
      roleName: `aistudio-${props.environment}-scheduler-execution-role`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Role for EventBridge Scheduler to invoke schedule executor Lambda',
    });

    // Grant EventBridge Scheduler permission to invoke the Lambda function directly
    this.scheduleExecutorFunction.addPermission('AllowEventBridgeSchedulerInvoke', {
      principal: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceAccount: this.account,
    });

    // Legacy: Grant EventBridge Scheduler permission to invoke the Lambda function via role (kept for backward compatibility)
    this.scheduleExecutorFunction.grantInvoke(this.schedulerExecutionRole);

    // Add scheduler execution role ARN to Lambda environment
    // This is required for the Lambda to create/update/delete EventBridge schedules
    this.scheduleExecutorFunction.addEnvironment(
      'SCHEDULER_EXECUTION_ROLE_ARN',
      this.schedulerExecutionRole.roleArn
    );

    // Allow Lambda to reach ECS ALB on port 80
    // Get ALB security group from SSM (stored by FrontendStackEcs)
    const albSecurityGroupId = ssm.StringParameter.valueForStringParameter(
      this,
      `/aistudio/${props.environment}/alb-security-group-id`
    );

    const albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'AlbSecurityGroup',
      albSecurityGroupId
    );

    // Allow Lambda SG to connect to ALB on port 80
    albSecurityGroup.addIngressRule(
      lambdaSg,
      ec2.Port.tcp(80),
      'Allow schedule executor Lambda to reach ALB'
    );

    // IAM Role for the Lambda function
    this.scheduleExecutorRole = this.scheduleExecutorFunction.role as iam.Role;

    // Grant RDS Data API permissions to Lambda
    const rdsDataApiPolicy = new iam.PolicyStatement({
      actions: [
        'rds-data:ExecuteStatement',
        'rds-data:BatchExecuteStatement',
        'rds-data:BeginTransaction',
        'rds-data:CommitTransaction',
        'rds-data:RollbackTransaction',
      ],
      resources: [databaseResourceArn],
    });

    const secretsManagerPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        databaseSecretArn,
        // Allow reading internal API secret (ARN read from SSM at runtime)
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:aistudio-${props.environment}-internal-api-secret-*`,
      ],
    });

    this.scheduleExecutorFunction.addToRolePolicy(rdsDataApiPolicy);
    this.scheduleExecutorFunction.addToRolePolicy(secretsManagerPolicy);

    // Grant EventBridge Scheduler management permissions to Lambda (for schedule CRUD operations)
    const schedulerManagementPolicy = new iam.PolicyStatement({
      actions: [
        'scheduler:CreateSchedule',
        'scheduler:GetSchedule',
        'scheduler:UpdateSchedule',
        'scheduler:DeleteSchedule',
        'scheduler:ListSchedules',
      ],
      resources: [
        `arn:aws:scheduler:${this.region}:${this.account}:schedule/default/aistudio-${props.environment}-*`,
      ],
    });

    this.scheduleExecutorFunction.addToRolePolicy(schedulerManagementPolicy);

    // Grant iam:PassRole permission to pass the scheduler execution role to EventBridge Scheduler
    const passRolePolicy = new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [this.schedulerExecutionRole.roleArn],
      conditions: {
        StringEquals: {
          'iam:PassedToService': 'scheduler.amazonaws.com'
        }
      }
    });
    this.scheduleExecutorFunction.addToRolePolicy(passRolePolicy);

    // Grant access to AI provider configurations, ECS endpoint, and internal API secret ARN (SSM Parameter Store)
    const ssmParameterPolicy = new iam.PolicyStatement({
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath',
      ],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/aistudio/${props.environment}/providers/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/aistudio/${props.environment}/openai/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/aistudio/${props.environment}/google/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/aistudio/${props.environment}/azure/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/aistudio/${props.environment}/bedrock/*`,
        // Grant access to ECS internal endpoint (created by FrontendStack-ECS)
        `arn:aws:ssm:${this.region}:${this.account}:parameter/aistudio/${props.environment}/ecs-internal-endpoint`,
        // Grant access to internal API secret ARN (created by FrontendStack-ECS)
        `arn:aws:ssm:${this.region}:${this.account}:parameter/aistudio/${props.environment}/internal-api-secret-arn`,
      ],
    });
    this.scheduleExecutorFunction.addToRolePolicy(ssmParameterPolicy);

    // Grant Bedrock access for AWS-hosted models
    const bedrockPolicy = new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-opus-20240229-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-instant-v1`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-v2:1`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-v2`,
      ],
    });
    this.scheduleExecutorFunction.addToRolePolicy(bedrockPolicy);

    // Grant SQS permissions for DLQ
    this.deadLetterQueue.grantSendMessages(this.scheduleExecutorFunction);

    // Update environment with scheduler execution role ARN
    this.scheduleExecutorFunction.addEnvironment('SCHEDULER_EXECUTION_ROLE_ARN', this.schedulerExecutionRole.roleArn);
    // Note: Lambda function can determine its own ARN at runtime using context.invokedFunctionArn or AWS_LAMBDA_FUNCTION_NAME

    // Store the executor function ARN in SSM for API access
    new ssm.StringParameter(this, 'ScheduleExecutorFunctionArnParam', {
      parameterName: `/aistudio/${props.environment}/schedule-executor-function-arn`,
      stringValue: this.scheduleExecutorFunction.functionArn,
      description: 'ARN of the schedule executor Lambda function',
    });

    // Store the scheduler execution role ARN in SSM for schedule creation
    new ssm.StringParameter(this, 'SchedulerExecutionRoleArnParam', {
      parameterName: `/aistudio/${props.environment}/scheduler-execution-role-arn`,
      stringValue: this.schedulerExecutionRole.roleArn,
      description: 'ARN of the EventBridge Scheduler execution role',
    });

    // Outputs
    new cdk.CfnOutput(this, 'ScheduleExecutorFunctionNameOutput', {
      value: this.scheduleExecutorFunction.functionName,
      description: 'Name of the schedule executor Lambda function',
      exportName: `${props.environment}-ScheduleExecutorFunctionName`,
    });

    new cdk.CfnOutput(this, 'ScheduleExecutorFunctionArnOutput', {
      value: this.scheduleExecutorFunction.functionArn,
      description: 'ARN of the schedule executor Lambda function',
      exportName: `${props.environment}-ScheduleExecutorFunctionArn`,
    });

    new cdk.CfnOutput(this, 'SchedulerExecutionRoleArnOutput', {
      value: this.schedulerExecutionRole.roleArn,
      description: 'ARN of the EventBridge Scheduler execution role',
      exportName: `${props.environment}-SchedulerExecutionRoleArn`,
    });

    new cdk.CfnOutput(this, 'ScheduleExecutionDLQUrl', {
      value: this.deadLetterQueue.queueUrl,
      description: 'URL of the schedule execution dead letter queue',
      exportName: `${props.environment}-ScheduleExecutionDLQUrl`,
    });

    new cdk.CfnOutput(this, 'ScheduleExecutionDLQArn', {
      value: this.deadLetterQueue.queueArn,
      description: 'ARN of the schedule execution dead letter queue',
      exportName: `${props.environment}-ScheduleExecutionDLQArn`,
    });
  }
}