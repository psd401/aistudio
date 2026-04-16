import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';
import { execSync } from 'child_process';
// ALPHA CDK CONSTRUCT: @aws-cdk/aws-bedrock-agentcore-alpha has no API stability
// guarantee and may introduce breaking changes on any release. Version is pinned
// (not caret) in infra/package.json. Review changelog before upgrading.
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import {
  VPCProvider,
  IEnvironmentConfig,
} from './constructs';
import { ServiceRoleFactory } from './constructs/security';

export interface AgentPlatformStackProps extends cdk.StackProps {
  environment: 'dev' | 'staging' | 'prod';
  config: IEnvironmentConfig;
  /** Aurora database resource ARN from DatabaseStack */
  databaseResourceArn: string;
  /** Aurora database secret ARN from DatabaseStack */
  databaseSecretArn: string;
  /** Bedrock Guardrail ARN from GuardrailsStack */
  guardrailArn: string;
  /** Bedrock Guardrail ID from GuardrailsStack */
  guardrailId: string;
  /** Bedrock Guardrail version — use 'DRAFT' for dev, a published version number for prod */
  guardrailVersion?: string;
  /** Aurora database name (default: 'aistudio') — sourced from CDK props for consistency */
  databaseName?: string;
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
  /** AgentCore Runtime (undefined until an image is pushed to ECR) */
  public readonly runtime?: agentcore.Runtime;
  /** AgentCore execution IAM role */
  public readonly agentCoreExecutionRole: iam.Role;
  /** Router Lambda IAM role */
  public readonly routerLambdaRole: iam.Role;
  /** Cron Lambda IAM role */
  public readonly cronLambdaRole: iam.Role;
  /** Router Lambda function */
  public readonly routerLambda: lambda.Function;
  /** SQS queue for Google Chat Pub/Sub messages */
  public readonly routerQueue: sqs.Queue;
  /** Google service account credentials secret */
  public readonly googleCredentialsSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: AgentPlatformStackProps) {
    super(scope, id, props);

    const { environment, config } = props;

    // Validate required ARN props at synth time to surface errors early
    // rather than waiting for opaque CloudFormation deploy-time failures.
    if (!props.guardrailArn) {
      throw new Error('AgentPlatformStack: guardrailArn is required');
    }
    if (!props.databaseResourceArn) {
      throw new Error('AgentPlatformStack: databaseResourceArn is required');
    }
    if (!props.databaseSecretArn) {
      throw new Error('AgentPlatformStack: databaseSecretArn is required');
    }

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
      // SSE-S3 chosen over SSE-KMS: workspace data is agent-generated artifacts
      // (not direct student PII). KMS adds ~$1/mo per key + $0.03/10k API calls.
      // Upgrade to SSE-KMS with dedicated key if student data is stored here.
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: environment !== 'prod',
      // S3 Intelligent Tiering for cost optimization (no expiration — keep forever).
      // Archive Access (90d): objects retrievable in minutes.
      // Deep Archive (180d): objects require a Restore request (12-48 hours).
      // If ad-hoc access to older workspace data is needed (audits, replays),
      // either remove deepArchiveAccessTierTime or plan for restore latency.
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
    // TTL enabled on 'expiresAt' attribute for automatic cleanup of stale signals.
    // Application code must set 'expiresAt' (epoch seconds) on each item.
    this.signalsTable = new dynamodb.Table(this, 'AgentSignalsTable', {
      tableName: `psd-agent-signals-${environment}`,
      partitionKey: { name: 'building', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'weekTopic', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    cdk.Tags.of(this.signalsTable).add('Environment', environment);
    cdk.Tags.of(this.signalsTable).add('ManagedBy', 'cdk');

    // =====================================================================
    // 4c. Google Credentials Secret (imported, created manually in console)
    // =====================================================================
    // Imported before IAM roles so the secret ARN can be included in the
    // ServiceRoleFactory `secrets` array (avoids standalone addToPolicy calls).
    // The Google service account JSON must be created before deploying:
    //   aws secretsmanager create-secret --name psd-agent-google-sa-<env> \
    //     --secret-string file://service-account.json
    this.googleCredentialsSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'GoogleCredentialsSecret',
      `psd-agent-google-sa-${environment}`,
    );

    // =====================================================================
    // 5. IAM Roles
    // =====================================================================

    // 5a. AgentCore execution role
    // BYPASS ServiceRoleFactory: AgentCore requires bedrock-agentcore.amazonaws.com
    // as trust principal, which ServiceRoleFactory doesn't support. Only the AgentCore
    // service principal is included — bedrock.amazonaws.com and ecs-tasks.amazonaws.com
    // were removed as they are not required by AgentCore Runtime and broaden the
    // attack surface unnecessarily. aws:SourceAccount condition prevents confused-deputy.
    this.agentCoreExecutionRole = new iam.Role(this, 'AgentCoreExecutionRole', {
      roleName: `psd-agentcore-execution-${environment}`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
      description: `AgentCore execution role for PSD AI Agent Platform (${environment})`,
    });

    cdk.Tags.of(this.agentCoreExecutionRole).add('Environment', environment);
    cdk.Tags.of(this.agentCoreExecutionRole).add('ManagedBy', 'cdk');

    // Bedrock model invocation
    // INTENTIONAL: Broad model access (foundation-model/*) because the agent platform
    // must support model selection at runtime based on admin configuration in AI Studio.
    // Cost guardrails are enforced at the application layer via the Guardrails stack,
    // not at the IAM layer. Tighten to specific model ARNs if static model set is adopted.
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockModelInvocation',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse',
        'bedrock:ConverseStream',
      ],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/*`,
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
        // Cross-region inference profiles use region-less format (us, eu, ap)
        // See: https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
        `arn:aws:bedrock:us:${this.account}:inference-profile/*`,
      ],
    }));

    // ListFoundationModels does not support resource-level permissions — must use '*'
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockListModels',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:ListFoundationModels'],
      resources: ['*'],
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

    // SSM Parameter Store — read config/cross-stack references at runtime
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMParameterAccess',
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

    // CloudWatch Logs — both log group and log stream ARNs required for
    // CreateLogStream/PutLogEvents. Covering both /aws/bedrock/agentcore/ and
    // /aws/bedrock-agentcore/ patterns since the alpha construct may use either.
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
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock/agentcore/*:*`,
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`,
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*:*`,
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

    // DynamoDB read/write — agent container accesses USERS_TABLE and SIGNALS_TABLE
    // Note: DynamoDB does not support aws:ResourceTag condition keys.
    // Table ARN scoping provides equivalent isolation.
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
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
    }));

    // Aurora access — agent container uses DATABASE_RESOURCE_ARN for telemetry writes
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AuroraAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        'rds-data:ExecuteStatement',
        'rds-data:BatchExecuteStatement',
      ],
      resources: [props.databaseResourceArn],
    }));

    // Secrets Manager — read DB credentials referenced by DATABASE_SECRET_ARN
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SecretsManagerAccess',
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.databaseSecretArn],
    }));

    // Cost allocation tags on role sessions
    cdk.Tags.of(this.agentCoreExecutionRole).add('department', 'technology');
    cdk.Tags.of(this.agentCoreExecutionRole).add('costCenter', 'ai-agents');

    // 5b. Router Lambda role — via ServiceRoleFactory
    // VPC access via managed policy (not vpcEnabled) to avoid policy validator
    // flagging ENI wildcard resources. AgentCore-specific policies passed as
    // additionalPolicies since ServiceRoleFactory doesn't have built-in props
    // for bedrock-agentcore, guardrails, or rds-data.
    this.routerLambdaRole = ServiceRoleFactory.createLambdaRole(this, 'RouterLambdaRole', {
      functionName: 'psd-agent-router',
      environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      dynamodbTables: [this.usersTable.tableName, this.signalsTable.tableName],
      s3Buckets: [this.workspaceBucket.bucketName],
      secrets: [props.databaseSecretArn, this.googleCredentialsSecret.secretArn],
      additionalPolicies: [
        // Guardrails invoke
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'GuardrailsInvoke',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:ApplyGuardrail', 'bedrock:GetGuardrail'],
            resources: [props.guardrailArn],
          })],
        }),
        // Aurora rds-data for telemetry writes
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AuroraAccess',
            effect: iam.Effect.ALLOW,
            actions: ['rds-data:ExecuteStatement', 'rds-data:BatchExecuteStatement'],
            resources: [props.databaseResourceArn],
          })],
        }),
        // AgentCore session invoke
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AgentCoreInvoke',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock-agentcore:InvokeRuntime', 'bedrock-agentcore:InvokeRuntimeForUser'],
            resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`],
          })],
        }),
        // SSM Parameter Store — resolve AgentCore Runtime ID and config at runtime
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'SSMParameterAccess',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter', 'ssm:GetParameters'],
            resources: [
              `arn:aws:ssm:${this.region}:${this.account}:parameter/aistudio/${environment}/*`,
            ],
          })],
        }),
      ],
    });

    // Attach VPC access via AWS managed policy (ENI operations require wildcard
    // resources which the ServiceRoleFactory policy validator rejects)
    this.routerLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );

    // 5c. Cron Lambda role — via ServiceRoleFactory
    // Note: ServiceRoleFactory grants full DynamoDB CRUD; cron only needs read.
    // Accepted tradeoff for consistency — table ARN scoping limits blast radius.
    // TODO(#887): Tighten to read-only DynamoDB when ServiceRoleFactory supports
    // granular permission levels (track as follow-up).
    this.cronLambdaRole = ServiceRoleFactory.createLambdaRole(this, 'CronLambdaRole', {
      functionName: 'psd-agent-cron',
      environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      dynamodbTables: [this.usersTable.tableName],
      additionalPolicies: [
        // AgentCore session invoke
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AgentCoreInvoke',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock-agentcore:InvokeRuntime', 'bedrock-agentcore:InvokeRuntimeForUser'],
            resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`],
          })],
        }),
      ],
    });

    // =====================================================================
    // 6. AgentCore Runtime
    // =====================================================================

    // AgentCore Runtime — only created when a real image tag is provided.
    // Pass --context agentImageTag=<tag> to deploy. Without it, the stack
    // deploys all supporting resources (ECR, S3, DynamoDB, IAM, EventBridge)
    // and the Runtime is added on a subsequent deploy after pushing an image.
    const imageTag = this.node.tryGetContext('agentImageTag') as string | undefined;

    if (imageTag) {
      this.runtime = new agentcore.Runtime(this, 'AgentCoreRuntime', {
        runtimeName: `psd_agent_${environment}`,
        agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(
          this.ecrRepository,
          imageTag,
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
      });

      cdk.Tags.of(this.runtime).add('Environment', environment);
      cdk.Tags.of(this.runtime).add('ManagedBy', 'cdk');
      cdk.Tags.of(this.runtime).add('Project', 'AIStudio');
    }

    // =====================================================================
    // 7. EventBridge Rules — Agent Cron Jobs
    // =====================================================================
    // All rules DISABLED by default until the Cron Lambda is created in a
    // separate issue. The rules will target the Cron Lambda once it exists.

    const cronSchedules = config.agent.cronSchedules;

    // EventBridge rules for agent cron jobs. Disabled until Cron Lambda is created.
    // CDK registers constructs in the construct tree by ID at construction time —
    // no variable reference needed. Variables will be added when addTarget() is
    // called after the Cron Lambda is implemented.

    const ruleDefinitions = [
      {
        id: 'MorningBriefRule',
        name: `psd-agent-morning-brief-${environment}`,
        description: 'Morning briefing for PSD AI agents — 9 AM PDT / 16:00 UTC weekdays',
        schedule: cronSchedules.morningBrief,
      },
      {
        id: 'EveningWrapRule',
        name: `psd-agent-evening-wrap-${environment}`,
        description: 'Evening wrap-up for PSD AI agents — 6 PM PDT / 01:00 UTC weekdays',
        schedule: cronSchedules.eveningWrap,
      },
      {
        id: 'WeeklySummaryRule',
        name: `psd-agent-weekly-summary-${environment}`,
        description: 'Weekly summary for PSD AI agents — 3 PM PDT Friday / 22:00 UTC',
        schedule: cronSchedules.weeklySummary,
      },
      {
        id: 'KaizenScanRule',
        name: `psd-agent-kaizen-scan-${environment}`,
        description: 'Kaizen improvement scan for PSD AI agents — 8 PM PDT Sunday / 03:00 UTC Monday',
        schedule: cronSchedules.kaizenScan,
      },
    ];

    for (const def of ruleDefinitions) {
      const rule = new events.Rule(this, def.id, {
        ruleName: def.name,
        description: def.description,
        schedule: events.Schedule.expression(def.schedule),
        enabled: false,
      });
      cdk.Tags.of(rule).add('Environment', environment);
      cdk.Tags.of(rule).add('ManagedBy', 'cdk');
    }

    // =====================================================================
    // 8. SQS Queue — Google Chat Pub/Sub Inbound
    // =====================================================================
    // Messages flow: Google Chat → GCP Pub/Sub → (push subscription to SQS) → Lambda
    // Dead-letter queue captures messages that fail processing after retries.
    //
    // PREREQUISITE: The GCP Pub/Sub → SQS bridge requires an SQS queue policy
    // granting sqs:SendMessage to the GCP push subscription's IAM principal.
    // This is configured outside CDK as part of the cross-cloud bridge setup.
    // See PR #902 prerequisites in the README for setup instructions.

    const routerDlq = new sqs.Queue(this, 'RouterDLQ', {
      queueName: `psd-agent-router-dlq-${environment}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    cdk.Tags.of(routerDlq).add('Environment', environment);
    cdk.Tags.of(routerDlq).add('ManagedBy', 'cdk');

    this.routerQueue = new sqs.Queue(this, 'RouterQueue', {
      queueName: `psd-agent-router-${environment}`,
      // AWS recommends visibility timeout >= 6x Lambda timeout to prevent
      // duplicate processing. Lambda timeout is 3 min, so 18 min minimum.
      visibilityTimeout: cdk.Duration.minutes(18),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: routerDlq,
        maxReceiveCount: 3, // 3 retries before DLQ
      },
    });
    cdk.Tags.of(this.routerQueue).add('Environment', environment);
    cdk.Tags.of(this.routerQueue).add('ManagedBy', 'cdk');

    // =====================================================================
    // 9. Router Lambda Function
    // =====================================================================

    const routerLogGroup = new logs.LogGroup(this, 'RouterLogGroup', {
      logGroupName: `/aws/lambda/psd-agent-router-${environment}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(routerLogGroup).add('Environment', environment);
    cdk.Tags.of(routerLogGroup).add('ManagedBy', 'cdk');

    // Pre-build the Router Lambda locally using bun (consistent with build-lambdas.sh).
    // The bundling.local command runs first; Docker is the fallback. Since the project
    // uses bun (not npm), and the Docker bundling image doesn't have bun, local bundling
    // is the primary path. CI/CD should run build-lambdas.sh before cdk synth.
    this.routerLambda = new lambda.Function(this, 'RouterLambda', {
      functionName: `psd-agent-router-${environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-router'),
        {
          bundling: {
            image: lambda.Runtime.NODEJS_20_X.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'agent-router');
                  // Build with all deps (including devDependencies for tsc)
                  execSync('bun install && bunx tsc', { cwd: inputDir, stdio: 'inherit' });
                  // Copy compiled JS to output
                  execSync(`cp -r dist/* ${outputDir}/`, { cwd: inputDir, stdio: 'inherit' });
                  // Copy package.json and install production-only deps in output
                  execSync(`cp package.json ${outputDir}/`, { cwd: inputDir, stdio: 'inherit' });
                  execSync('bun install --production', { cwd: outputDir, stdio: 'inherit' });
                  return true;
                } catch {
                  return false;
                }
              },
            },
            command: [
              'bash', '-c',
              [
                // Docker fallback: use npm since it's available in the bundling image
                'npm install',
                'npm run build',
                'cp -r dist/* /asset-output/',
                'cp package.json /asset-output/',
                'cd /asset-output && npm install --production',
              ].join(' && '),
            ],
          },
        },
      ),
      memorySize: config.compute.lambdaMemory,
      timeout: cdk.Duration.minutes(3), // Agent responses can take time
      architecture: lambda.Architecture.ARM_64,
      role: this.routerLambdaRole,
      logGroup: routerLogGroup,
      tracing: config.monitoring.tracingEnabled
        ? lambda.Tracing.ACTIVE
        : lambda.Tracing.DISABLED,
      environment: {
        ENVIRONMENT: environment,
        USERS_TABLE: this.usersTable.tableName,
        GUARDRAIL_ID: props.guardrailId,
        GUARDRAIL_VERSION: props.guardrailVersion || 'DRAFT',
        DATABASE_RESOURCE_ARN: props.databaseResourceArn,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
        DATABASE_NAME: props.databaseName || 'aistudio',
        GOOGLE_CREDENTIALS_SECRET_ARN: this.googleCredentialsSecret.secretArn,
        TOKEN_LIMIT_PER_INTERACTION: '100000',
        // K-12 safety: fail closed when guardrails are unavailable
        GUARDRAIL_FAIL_OPEN: 'false',
        // Only allow messages from PSD domain emails
        ALLOWED_DOMAINS: 'psd401.net',
        NODE_ENV: 'production',
        // AGENTCORE_RUNTIME_ID is intentionally NOT set here — it is resolved
        // from SSM at runtime because the Runtime resource is conditionally
        // created only when an image tag is provided via CDK context.
      },
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    cdk.Tags.of(this.routerLambda).add('Environment', environment);
    cdk.Tags.of(this.routerLambda).add('ManagedBy', 'cdk');

    // Wire SQS → Lambda trigger
    // NOTE on duplicate processing: With batchSize=1 and 18-min visibility timeout
    // (6x Lambda timeout), duplicates are unlikely but possible if the Lambda times
    // out after invoking AgentCore but before completing (e.g., Google Chat API slow).
    // The blast radius is one duplicate response per affected message. If this occurs
    // in production, add SQS messageId-keyed dedup (e.g., DynamoDB conditional write
    // before calling Google Chat) as a follow-up optimization.
    this.routerLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(this.routerQueue, {
        batchSize: 1, // Process one message at a time for reliable error handling
        maxBatchingWindow: cdk.Duration.seconds(0), // No batching delay — respond ASAP
      }),
    );

    // CloudWatch alarm on the DLQ — fires when any message lands in the dead-letter
    // queue, meaning a user's message was silently dropped after 3 retries. In a K-12
    // environment this warrants immediate investigation.
    new cloudwatch.Alarm(this, 'RouterDlqAlarm', {
      alarmName: `psd-agent-router-dlq-${environment}`,
      alarmDescription: 'Agent Router DLQ received messages — investigate dropped messages',
      metric: routerDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // =====================================================================
    // 10. SSM Parameters — Cross-Stack References
    // =====================================================================
    // All SSM parameters tagged for IAM tag-based access control compliance.

    const ssmParams = [
      new ssm.StringParameter(this, 'ECRRepositoryArnParam', {
        parameterName: `/aistudio/${environment}/agent-ecr-repository-arn`,
        stringValue: this.ecrRepository.repositoryArn,
        description: 'ECR repository ARN for agent base image',
      }),
      new ssm.StringParameter(this, 'ECRRepositoryUriParam', {
        parameterName: `/aistudio/${environment}/agent-ecr-repository-uri`,
        stringValue: this.ecrRepository.repositoryUri,
        description: 'ECR repository URI for agent base image',
      }),
      new ssm.StringParameter(this, 'WorkspaceBucketNameParam', {
        parameterName: `/aistudio/${environment}/agent-workspace-bucket-name`,
        stringValue: this.workspaceBucket.bucketName,
        description: 'S3 bucket name for agent workspaces',
      }),
      new ssm.StringParameter(this, 'UsersTableNameParam', {
        parameterName: `/aistudio/${environment}/agent-users-table-name`,
        stringValue: this.usersTable.tableName,
        description: 'DynamoDB table name for agent user identity mapping',
      }),
      new ssm.StringParameter(this, 'SignalsTableNameParam', {
        parameterName: `/aistudio/${environment}/agent-signals-table-name`,
        stringValue: this.signalsTable.tableName,
        description: 'DynamoDB table name for organizational signals',
      }),
      ...(this.runtime ? [new ssm.StringParameter(this, 'AgentCoreRuntimeIdParam', {
        parameterName: `/aistudio/${environment}/agentcore-runtime-id`,
        stringValue: this.runtime.agentRuntimeId,
        description: 'AgentCore Runtime ID',
      })] : []),
      new ssm.StringParameter(this, 'AgentCoreExecutionRoleArnParam', {
        parameterName: `/aistudio/${environment}/agentcore-execution-role-arn`,
        stringValue: this.agentCoreExecutionRole.roleArn,
        description: 'AgentCore execution role ARN',
      }),
      new ssm.StringParameter(this, 'RouterLambdaRoleArnParam', {
        parameterName: `/aistudio/${environment}/agent-router-lambda-role-arn`,
        stringValue: this.routerLambdaRole.roleArn,
        description: 'Router Lambda role ARN',
      }),
      new ssm.StringParameter(this, 'CronLambdaRoleArnParam', {
        parameterName: `/aistudio/${environment}/agent-cron-lambda-role-arn`,
        stringValue: this.cronLambdaRole.roleArn,
        description: 'Cron Lambda role ARN',
      }),
      new ssm.StringParameter(this, 'RouterQueueUrlParam', {
        parameterName: `/aistudio/${environment}/agent-router-queue-url`,
        stringValue: this.routerQueue.queueUrl,
        description: 'SQS queue URL for Google Chat Pub/Sub messages',
      }),
      new ssm.StringParameter(this, 'RouterQueueArnParam', {
        parameterName: `/aistudio/${environment}/agent-router-queue-arn`,
        stringValue: this.routerQueue.queueArn,
        description: 'SQS queue ARN for Google Chat Pub/Sub messages',
      }),
      new ssm.StringParameter(this, 'RouterLambdaArnParam', {
        parameterName: `/aistudio/${environment}/agent-router-lambda-arn`,
        stringValue: this.routerLambda.functionArn,
        description: 'Router Lambda function ARN',
      }),
    ];

    for (const param of ssmParams) {
      cdk.Tags.of(param).add('Environment', environment);
      cdk.Tags.of(param).add('ManagedBy', 'cdk');
    }

    // =====================================================================
    // 11. CloudFormation Outputs
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

    if (this.runtime) {
      new cdk.CfnOutput(this, 'AgentCoreRuntimeId', {
        value: this.runtime.agentRuntimeId,
        description: 'AgentCore Runtime ID',
      });

      new cdk.CfnOutput(this, 'AgentCoreRuntimeArn', {
        value: this.runtime.agentRuntimeArn,
        description: 'AgentCore Runtime ARN',
      });
    }

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

    new cdk.CfnOutput(this, 'RouterLambdaArn', {
      value: this.routerLambda.functionArn,
      description: 'Router Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'RouterQueueUrl', {
      value: this.routerQueue.queueUrl,
      description: 'SQS queue URL for Google Chat messages',
    });

    new cdk.CfnOutput(this, 'RouterQueueArn', {
      value: this.routerQueue.queueArn,
      description: 'SQS queue ARN for Google Chat messages',
    });
  }
}
