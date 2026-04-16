import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import {
  VPCProvider,
  EnvironmentConfig,
  IEnvironmentConfig,
} from './constructs';

export interface AgentPlatformStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
  config: IEnvironmentConfig;
  /** Aurora database resource ARN from DatabaseStack */
  databaseResourceArn: string;
  /** Aurora database secret ARN from DatabaseStack */
  databaseSecretArn: string;
  /** Bedrock Guardrail ARN from GuardrailsStack */
  guardrailArn: string;
}

/**
 * AgentPlatformStack - Foundational infrastructure for the PSD AI Agent Platform
 *
 * Creates:
 * - AgentCore Runtime with ECR-based container image
 * - ECR repository for the agent Docker image
 * - S3 bucket for agent workspaces (S3 Files enabled, per-user prefixes)
 * - DynamoDB tables for user identity mapping and organizational signals
 * - EventBridge rules for agent cron jobs (disabled until Cron Lambda exists)
 * - IAM roles for AgentCore execution, Router Lambda, and Cron Lambda
 * - SSM parameters for cross-stack references
 *
 * References (not creates):
 * - VPC from DatabaseStack via VPCProvider
 * - Aurora cluster via imported ARNs
 * - Guardrails via imported ARN
 */
export class AgentPlatformStack extends cdk.Stack {
  /** ECR repository for agent Docker images */
  public readonly ecrRepository: ecr.Repository;
  /** S3 bucket for agent workspaces */
  public readonly workspaceBucket: s3.Bucket;
  /** DynamoDB table for user identity mapping */
  public readonly usersTable: dynamodb.Table;
  /** DynamoDB table for organizational signals (Nervous System) */
  public readonly signalsTable: dynamodb.Table;
  /** AgentCore Runtime */
  public readonly runtime: agentcore.Runtime;
  /** AgentCore execution IAM role */
  public readonly agentCoreExecutionRole: iam.Role;
  /** Router Lambda IAM role */
  public readonly routerLambdaRole: iam.Role;
  /** Cron Lambda IAM role */
  public readonly cronLambdaRole: iam.Role;

  constructor(scope: Construct, id: string, props: AgentPlatformStackProps) {
    super(scope, id, props);

    const { environment, config } = props;

    // =====================================================================
    // 1. VPC — shared from DatabaseStack
    // =====================================================================
    const vpc = VPCProvider.getOrCreate(this, environment, config);

    // =====================================================================
    // 2. ECR Repository
    // =====================================================================
    this.ecrRepository = new ecr.Repository(this, 'AgentBaseRepository', {
      repositoryName: `psd-agent-base-${environment}`,
      imageScanOnPush: true,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: environment !== 'prod',
      lifecycleRules: [
        {
          description: 'Keep last 10 images',
          maxImageCount: 10,
          rulePriority: 1,
        },
      ],
    });

    cdk.Tags.of(this.ecrRepository).add('Environment', environment);
    cdk.Tags.of(this.ecrRepository).add('ManagedBy', 'cdk');

    // =====================================================================
    // 3. S3 Bucket — Agent Workspaces
    // =====================================================================
    this.workspaceBucket = new s3.Bucket(this, 'AgentWorkspaceBucket', {
      bucketName: `psd-agents-${environment}-${cdk.Aws.ACCOUNT_ID}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: environment !== 'prod',
      // S3 Intelligent Tiering for cost optimization (no expiration — keep forever)
      intelligentTieringConfigurations: [
        {
          name: 'agent-workspace-tiering',
          archiveAccessTierTime: cdk.Duration.days(90),
          deepArchiveAccessTierTime: cdk.Duration.days(180),
        },
      ],
    });

    cdk.Tags.of(this.workspaceBucket).add('Environment', environment);
    cdk.Tags.of(this.workspaceBucket).add('ManagedBy', 'cdk');

    // =====================================================================
    // 4. DynamoDB Tables
    // =====================================================================

    // 4a. Agent Users table — user identity mapping
    this.usersTable = new dynamodb.Table(this, 'AgentUsersTable', {
      tableName: `psd-agent-users-${environment}`,
      partitionKey: { name: 'googleIdentity', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // GSI on department for admin queries
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'department-index',
      partitionKey: { name: 'department', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    cdk.Tags.of(this.usersTable).add('Environment', environment);
    cdk.Tags.of(this.usersTable).add('ManagedBy', 'cdk');

    // 4b. Agent Signals table — Organizational Nervous System (Phase 2-3, create now)
    this.signalsTable = new dynamodb.Table(this, 'AgentSignalsTable', {
      tableName: `psd-agent-signals-${environment}`,
      partitionKey: { name: 'building', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'weekTopic', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    cdk.Tags.of(this.signalsTable).add('Environment', environment);
    cdk.Tags.of(this.signalsTable).add('ManagedBy', 'cdk');

    // =====================================================================
    // 5. IAM Roles
    // =====================================================================

    // 5a. AgentCore execution role
    this.agentCoreExecutionRole = new iam.Role(this, 'AgentCoreExecutionRole', {
      roleName: `psd-agentcore-execution-${environment}`,
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        new iam.ServicePrincipal('bedrock.amazonaws.com'),
        new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      ),
      description: `AgentCore execution role for PSD AI Agent Platform (${environment})`,
    });

    cdk.Tags.of(this.agentCoreExecutionRole).add('Environment', environment);
    cdk.Tags.of(this.agentCoreExecutionRole).add('ManagedBy', 'cdk');

    // Bedrock model invocation
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockModelInvocation',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse',
        'bedrock:ConverseStream',
        'bedrock:ListFoundationModels',
      ],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/*`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
        `arn:aws:bedrock:us:${this.account}:inference-profile/*`,
      ],
    }));

    // S3 workspace read/write
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3WorkspaceAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:GetObjectVersion',
        's3:PutObject',
        's3:DeleteObject',
        's3:ListBucket',
        's3:GetBucketLocation',
      ],
      resources: [
        this.workspaceBucket.bucketArn,
        `${this.workspaceBucket.bucketArn}/*`,
      ],
    }));

    // ECR pull for agent images
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECRPullAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:BatchCheckLayerAvailability',
      ],
      resources: [this.ecrRepository.repositoryArn],
    }));

    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECRAuthToken',
      effect: iam.Effect.ALLOW,
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'], // GetAuthorizationToken does not support resource-level permissions
    }));

    // SSM managed instance core (for debugging)
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMDebugAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath',
      ],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/aistudio/${environment}/*`,
      ],
    }));

    // CloudWatch Logs
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogs',
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock/agentcore/*`,
      ],
    }));

    // Guardrails access
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'GuardrailsAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:ApplyGuardrail',
        'bedrock:GetGuardrail',
      ],
      resources: [props.guardrailArn],
    }));

    // Cost allocation tags on role sessions
    cdk.Tags.of(this.agentCoreExecutionRole).add('department', 'technology');
    cdk.Tags.of(this.agentCoreExecutionRole).add('costCenter', 'ai-agents');

    // 5b. Router Lambda role (created via ServiceRoleFactory pattern — inline for custom trust)
    this.routerLambdaRole = new iam.Role(this, 'RouterLambdaRole', {
      roleName: `psd-agent-router-lambda-${environment}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Router Lambda role for PSD AI Agent Platform (${environment})`,
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          'RouterLambdaBasicExecPolicy',
          'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ),
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          'RouterLambdaVPCAccessPolicy',
          'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
        ),
      ],
    });

    cdk.Tags.of(this.routerLambdaRole).add('Environment', environment);
    cdk.Tags.of(this.routerLambdaRole).add('ManagedBy', 'cdk');

    // Router: Guardrails invoke
    this.routerLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'GuardrailsInvoke',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:ApplyGuardrail',
        'bedrock:GetGuardrail',
      ],
      resources: [props.guardrailArn],
    }));

    // Router: DynamoDB read/write (both tables)
    this.routerLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDBAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ],
      resources: [
        this.usersTable.tableArn,
        `${this.usersTable.tableArn}/index/*`,
        this.signalsTable.tableArn,
        `${this.signalsTable.tableArn}/index/*`,
      ],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/Environment': environment,
          'aws:ResourceTag/ManagedBy': 'cdk',
        },
      },
    }));

    // Router: Aurora write (telemetry — uses existing DB cluster)
    this.routerLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AuroraAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'rds-data:ExecuteStatement',
        'rds-data:BatchExecuteStatement',
      ],
      resources: [props.databaseResourceArn],
    }));

    // Router: Secrets Manager read for DB credentials
    this.routerLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SecretsManagerAccess',
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.databaseSecretArn],
    }));

    // Router: S3 read (shared knowledge)
    this.routerLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3SharedKnowledgeRead',
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:ListBucket',
      ],
      resources: [
        this.workspaceBucket.bucketArn,
        `${this.workspaceBucket.bucketArn}/shared/*`,
      ],
    }));

    // Router: AgentCore session invoke
    this.routerLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreInvoke',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:InvokeRuntime',
        'bedrock-agentcore:InvokeRuntimeForUser',
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`,
      ],
    }));

    // 5c. Cron Lambda role
    this.cronLambdaRole = new iam.Role(this, 'CronLambdaRole', {
      roleName: `psd-agent-cron-lambda-${environment}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Cron Lambda role for PSD AI Agent Platform (${environment})`,
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          'CronLambdaBasicExecPolicy',
          'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    cdk.Tags.of(this.cronLambdaRole).add('Environment', environment);
    cdk.Tags.of(this.cronLambdaRole).add('ManagedBy', 'cdk');

    // Cron: AgentCore session invoke
    this.cronLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCoreInvoke',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:InvokeRuntime',
        'bedrock-agentcore:InvokeRuntimeForUser',
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`,
      ],
    }));

    // Cron: DynamoDB read (user table — to enumerate users for cron jobs)
    this.cronLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDBRead',
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ],
      resources: [
        this.usersTable.tableArn,
        `${this.usersTable.tableArn}/index/*`,
      ],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/Environment': environment,
          'aws:ResourceTag/ManagedBy': 'cdk',
        },
      },
    }));

    // =====================================================================
    // 6. AgentCore Runtime
    // =====================================================================

    // Use a CloudFormation parameter for initial image tag to avoid requiring
    // a pre-existing image in ECR at stack creation time. The Dockerfile/image
    // will be pushed separately as part of the agent build pipeline.
    const imageTag = new cdk.CfnParameter(this, 'AgentImageTag', {
      type: 'String',
      default: 'latest',
      description: 'Docker image tag for the agent base image in ECR',
    });

    this.runtime = new agentcore.Runtime(this, 'AgentCoreRuntime', {
      runtimeName: `psd_agent_${environment}`,
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(
        this.ecrRepository,
        imageTag.valueAsString,
      ),
      executionRole: this.agentCoreExecutionRole,
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingVpc(this, {
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      }),
      description: `PSD AI Agent Platform runtime (${environment})`,
      environmentVariables: {
        ENVIRONMENT: environment,
        WORKSPACE_BUCKET: this.workspaceBucket.bucketName,
        USERS_TABLE: this.usersTable.tableName,
        SIGNALS_TABLE: this.signalsTable.tableName,
        GUARDRAIL_ARN: props.guardrailArn,
        DATABASE_RESOURCE_ARN: props.databaseResourceArn,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
      },
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: cdk.Duration.minutes(config.agent.microVmIdleTimeoutMinutes),
      },
      tags: {
        Environment: environment,
        ManagedBy: 'cdk',
        Project: 'AIStudio',
      },
    });

    // =====================================================================
    // 7. EventBridge Rules — Agent Cron Jobs
    // =====================================================================
    // All rules DISABLED by default until the Cron Lambda is created in a
    // separate issue. The rules will target the Cron Lambda once it exists.

    const cronSchedules = config.agent.cronSchedules;

    const morningBriefRule = new events.Rule(this, 'MorningBriefRule', {
      ruleName: `psd-agent-morning-brief-${environment}`,
      description: 'Morning briefing for PSD AI agents — 9am weekdays (Pacific)',
      schedule: events.Schedule.expression(cronSchedules.morningBrief),
      enabled: false, // Disabled until Cron Lambda exists
    });

    const eveningWrapRule = new events.Rule(this, 'EveningWrapRule', {
      ruleName: `psd-agent-evening-wrap-${environment}`,
      description: 'Evening wrap-up for PSD AI agents — 6pm weekdays (Pacific)',
      schedule: events.Schedule.expression(cronSchedules.eveningWrap),
      enabled: false,
    });

    const weeklySummaryRule = new events.Rule(this, 'WeeklySummaryRule', {
      ruleName: `psd-agent-weekly-summary-${environment}`,
      description: 'Weekly summary for PSD AI agents — 3pm Friday (Pacific)',
      schedule: events.Schedule.expression(cronSchedules.weeklySummary),
      enabled: false,
    });

    const kaizenScanRule = new events.Rule(this, 'KaizenScanRule', {
      ruleName: `psd-agent-kaizen-scan-${environment}`,
      description: 'Kaizen improvement scan for PSD AI agents — 8pm Sunday (Pacific)',
      schedule: events.Schedule.expression(cronSchedules.kaizenScan),
      enabled: false,
    });

    // =====================================================================
    // 8. SSM Parameters — Cross-Stack References
    // =====================================================================

    new ssm.StringParameter(this, 'ECRRepositoryArnParam', {
      parameterName: `/aistudio/${environment}/agent-ecr-repository-arn`,
      stringValue: this.ecrRepository.repositoryArn,
      description: 'ECR repository ARN for agent base image',
    });

    new ssm.StringParameter(this, 'ECRRepositoryUriParam', {
      parameterName: `/aistudio/${environment}/agent-ecr-repository-uri`,
      stringValue: this.ecrRepository.repositoryUri,
      description: 'ECR repository URI for agent base image',
    });

    new ssm.StringParameter(this, 'WorkspaceBucketNameParam', {
      parameterName: `/aistudio/${environment}/agent-workspace-bucket-name`,
      stringValue: this.workspaceBucket.bucketName,
      description: 'S3 bucket name for agent workspaces',
    });

    new ssm.StringParameter(this, 'UsersTableNameParam', {
      parameterName: `/aistudio/${environment}/agent-users-table-name`,
      stringValue: this.usersTable.tableName,
      description: 'DynamoDB table name for agent user identity mapping',
    });

    new ssm.StringParameter(this, 'SignalsTableNameParam', {
      parameterName: `/aistudio/${environment}/agent-signals-table-name`,
      stringValue: this.signalsTable.tableName,
      description: 'DynamoDB table name for organizational signals',
    });

    new ssm.StringParameter(this, 'AgentCoreRuntimeIdParam', {
      parameterName: `/aistudio/${environment}/agentcore-runtime-id`,
      stringValue: this.runtime.agentRuntimeId,
      description: 'AgentCore Runtime ID',
    });

    new ssm.StringParameter(this, 'AgentCoreExecutionRoleArnParam', {
      parameterName: `/aistudio/${environment}/agentcore-execution-role-arn`,
      stringValue: this.agentCoreExecutionRole.roleArn,
      description: 'AgentCore execution role ARN',
    });

    new ssm.StringParameter(this, 'RouterLambdaRoleArnParam', {
      parameterName: `/aistudio/${environment}/agent-router-lambda-role-arn`,
      stringValue: this.routerLambdaRole.roleArn,
      description: 'Router Lambda role ARN',
    });

    new ssm.StringParameter(this, 'CronLambdaRoleArnParam', {
      parameterName: `/aistudio/${environment}/agent-cron-lambda-role-arn`,
      stringValue: this.cronLambdaRole.roleArn,
      description: 'Cron Lambda role ARN',
    });

    // =====================================================================
    // 9. CloudFormation Outputs
    // =====================================================================

    new cdk.CfnOutput(this, 'ECRRepositoryUri', {
      value: this.ecrRepository.repositoryUri,
      description: 'ECR repository URI for agent base image',
    });

    new cdk.CfnOutput(this, 'WorkspaceBucketName', {
      value: this.workspaceBucket.bucketName,
      description: 'S3 bucket for agent workspaces',
    });

    new cdk.CfnOutput(this, 'UsersTableName', {
      value: this.usersTable.tableName,
      description: 'DynamoDB table for agent users',
    });

    new cdk.CfnOutput(this, 'SignalsTableName', {
      value: this.signalsTable.tableName,
      description: 'DynamoDB table for organizational signals',
    });

    new cdk.CfnOutput(this, 'AgentCoreRuntimeId', {
      value: this.runtime.agentRuntimeId,
      description: 'AgentCore Runtime ID',
    });

    new cdk.CfnOutput(this, 'AgentCoreExecutionRoleArn', {
      value: this.agentCoreExecutionRole.roleArn,
      description: 'AgentCore execution role ARN',
    });

    new cdk.CfnOutput(this, 'RouterLambdaRoleArn', {
      value: this.routerLambdaRole.roleArn,
      description: 'Router Lambda role ARN',
    });

    new cdk.CfnOutput(this, 'CronLambdaRoleArn', {
      value: this.cronLambdaRole.roleArn,
      description: 'Cron Lambda role ARN',
    });
  }
}
