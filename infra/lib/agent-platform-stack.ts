import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as customResources from 'aws-cdk-lib/custom-resources';
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
  /** Aurora cluster endpoint hostname for direct PostgreSQL connection */
  databaseHost: string;
  /** Aurora database name (default: 'aistudio') — sourced from CDK props for consistency */
  databaseName?: string;
  /** Email for alarm notifications (DLQ, Lambda errors). If omitted, alarms fire but don't notify. */
  alertEmail?: string;
  /** Comma-separated email domains allowed to send messages (default: 'psd401.net') */
  allowedDomains?: string;
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
  /** DynamoDB table for Chat message idempotency (dedup of retries) */
  public readonly messageDedupTable: dynamodb.Table;
  /** IAM user that owns the Bedrock API key (service-specific credential) */
  public readonly bedrockApiUser: iam.User;
  /** Secrets Manager secret carrying the Bedrock API key for Mantle auth */
  public readonly bedrockApiKeySecret: secretsmanager.Secret;
  /** SNS topic for platform alarms (DLQ, API key expiry, etc.) */
  public readonly agentAlarmTopic?: sns.Topic;
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
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
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

    // 4c. Message Dedup table — idempotency guard for Chat → AgentCore.
    // Google Chat retries Pub/Sub deliveries when a bot is slow to ack, and
    // SQS may also redeliver under load. Without dedup, two invocations land
    // on the same OpenClaw session in parallel; OpenClaw rejects the second
    // with an empty fallback in ~135ms (observed). Conditional write keyed on
    // the immutable Chat message resource name (`spaces/X/messages/Y`)
    // collapses retries into one real invocation.
    //
    // TTL of 1 hour is plenty: a duplicate that arrives an hour after the
    // original is effectively a new request from the user's perspective.
    this.messageDedupTable = new dynamodb.Table(this, 'AgentMessageDedupTable', {
      tableName: `psd-agent-message-dedup-${environment}`,
      partitionKey: { name: 'messageName', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(this.messageDedupTable).add('Environment', environment);
    cdk.Tags.of(this.messageDedupTable).add('ManagedBy', 'cdk');

    // 4d. Inter-Agent Communication table — tracks agent-to-agent messages
    // for rate limiting and anti-loop detection. Uses TTL for automatic cleanup.
    const interAgentTable = new dynamodb.Table(this, 'AgentInterAgentTable', {
      tableName: `psd-agent-interagent-${environment}`,
      partitionKey: { name: 'senderBotId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sentAt', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(interAgentTable).add('Environment', environment);
    cdk.Tags.of(interAgentTable).add('ManagedBy', 'cdk');

    // 4e. Agent Schedules table — user-defined schedules, one row per schedule.
    // The psd-schedules OpenClaw skill writes to this table AND to EventBridge
    // Scheduler in the same transaction (with rollback on failure). No streams
    // or sync Lambda — the agent owns both sides and keeps them consistent.
    const schedulesTable = new dynamodb.Table(this, 'AgentSchedulesTable', {
      tableName: `psd-agent-schedules-${environment}`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'scheduleId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(schedulesTable).add('Environment', environment);
    cdk.Tags.of(schedulesTable).add('ManagedBy', 'cdk');

    // =====================================================================
    // 4f. Google Credentials Secret (CDK-managed, operator populates)
    // =====================================================================
    // CDK creates the secret with placeholder value. After deploy, populate
    // it with the Google service account JSON:
    //   aws secretsmanager put-secret-value \
    //     --secret-id psd-agent-google-sa-<env> \
    //     --secret-string file://service-account.json
    //
    // The Lambda reads this at runtime for Google Chat API authentication.
    this.googleCredentialsSecret = new secretsmanager.Secret(this, 'GoogleCredentialsSecret', {
      secretName: `psd-agent-google-sa-${environment}`,
      description: 'Google service account JSON for Chat API authentication. Populate after deploy with: aws secretsmanager put-secret-value --secret-id psd-agent-google-sa-<env> --secret-string file://service-account.json',
    });
    cdk.Tags.of(this.googleCredentialsSecret).add('Environment', environment);
    cdk.Tags.of(this.googleCredentialsSecret).add('ManagedBy', 'cdk');

    // =====================================================================
    // 4d. Bedrock API key — CDK-provisioned service-specific credential
    // =====================================================================
    // OpenClaw authenticates to Bedrock Mantle (the OpenAI-compatible
    // endpoint) with a Bearer token, which is an IAM "service-specific
    // credential" tied to a dedicated IAM user. The plumbing below makes
    // the whole lifecycle self-sufficient — no operator CLI step per env:
    //
    //   - IAM user       `psd-agent-bedrock-<env>` (CDK-managed)
    //   - Inline policy  scoped to bedrock:InvokeModel* on foundation models
    //   - Secret         `psd-agent-bedrock-api-key-<env>` (placeholder)
    //   - Lambda         bedrock-api-key-manager — provisions on CREATE,
    //                    handles scheduled rotation + expiry watchdog
    //   - Custom Resource fires the Lambda onCreate, which calls
    //                    iam:CreateServiceSpecificCredential and stashes
    //                    ServiceCredentialSecret into the Secret above
    //                    (the secret is only returned by IAM at CREATE time,
    //                    so this is the single atomic step that populates SM)
    //   - EventBridge    weekly watchdog, monthly rotation
    //
    // Delete the stack → Custom Resource revokes the credential, CDK deletes
    // user + secret. Nothing to clean up by hand.

    this.bedrockApiUser = new iam.User(this, 'BedrockApiUser', {
      userName: `psd-agent-bedrock-${environment}`,
    });
    // Mantle uses its own IAM namespace (`bedrock-mantle:*`) distinct from
    // `bedrock:*`. `AmazonBedrockMantleInferenceAccess` grants Get*/List*/
    // CreateInference/CallWithBearerToken — but we've observed OpenClaw
    // hitting `/v1/models` at gateway startup (`resolving authentication`)
    // and getting `access_denied: bedrock-mantle:ListModels` DESPITE the
    // `List*` wildcard. If ListModels fails, OpenClaw marks the provider
    // unauthorized for the rest of the session and every inference call
    // returns "401 Invalid bearer token". Grant `bedrock-mantle:*` broadly
    // on the default project — this user exists for nothing else.
    this.bedrockApiUser.attachInlinePolicy(
      new iam.Policy(this, 'BedrockApiUserMantlePolicy', {
        statements: [
          new iam.PolicyStatement({
            sid: 'MantleFullAccessOnDefaultProject',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock-mantle:*'],
            resources: [
              `arn:aws:bedrock-mantle:${this.region}:${this.account}:project/*`,
              `arn:aws:bedrock-mantle:${this.region}:${this.account}:*`,
              '*', // CallWithBearerToken uses "*" resource per the managed policy reference
            ],
          }),
          // Also grant native Bedrock invoke in case a component bypasses
          // Mantle. Scoped to foundation models + inference profiles in
          // this region.
          new iam.PolicyStatement({
            sid: 'InvokeBedrockModels',
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
            ],
          }),
          new iam.PolicyStatement({
            sid: 'ListModels',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:ListFoundationModels', 'bedrock:GetFoundationModel'],
            resources: ['*'],
          }),
        ],
      }),
    );
    cdk.Tags.of(this.bedrockApiUser).add('Environment', environment);
    cdk.Tags.of(this.bedrockApiUser).add('ManagedBy', 'cdk');

    this.bedrockApiKeySecret = new secretsmanager.Secret(this, 'BedrockApiKeySecret', {
      secretName: `psd-agent-bedrock-api-key-${environment}`,
      description: `Bedrock API key (long-term service-specific credential) for the agent platform. CDK-provisioned on stack create via BedrockApiKeyProvisioner custom resource. IAM user: psd-agent-bedrock-${environment}. Auto-rotated monthly.`,
    });
    cdk.Tags.of(this.bedrockApiKeySecret).add('Environment', environment);
    cdk.Tags.of(this.bedrockApiKeySecret).add('ManagedBy', 'cdk');

    // Alarm topic used by the watchdog — reuses the same alarm topic we
    // create for Router DLQ alerts further down. But we need it early here,
    // so we create it right now if alertEmail is configured; the DLQ block
    // below will reuse it.
    if (props.alertEmail) {
      this.agentAlarmTopic = new sns.Topic(this, 'AgentAlarmTopic', {
        topicName: `psd-agent-alarms-${environment}`,
        displayName: `PSD Agent Platform Alarms (${environment})`,
      });
      this.agentAlarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(props.alertEmail),
      );
      cdk.Tags.of(this.agentAlarmTopic).add('Environment', environment);
      cdk.Tags.of(this.agentAlarmTopic).add('ManagedBy', 'cdk');
    }

    const bedrockKeyManagerLogGroup = new logs.LogGroup(this, 'BedrockKeyManagerLogGroup', {
      logGroupName: `/aws/lambda/psd-agent-bedrock-key-manager-${environment}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const bedrockKeyManager = new lambda.Function(this, 'BedrockKeyManagerLambda', {
      functionName: `psd-agent-bedrock-key-manager-${environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'bedrock-api-key-manager'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: lambda.Runtime.NODEJS_20_X.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'bedrock-api-key-manager');
                  execSync('bun install && bunx tsc', { cwd: inputDir, stdio: 'inherit' });
                  execSync(`cp -r dist/* ${outputDir}/`, { cwd: inputDir, stdio: 'inherit' });
                  execSync(`cp package.json ${outputDir}/`, { cwd: inputDir, stdio: 'inherit' });
                  execSync('bun install --production', { cwd: outputDir, stdio: 'inherit' });
                  return true;
                } catch (e) {
                  // eslint-disable-next-line no-console
                  console.error('Local bundling failed, falling back to Docker:', e);
                  return false;
                }
              },
            },
            command: [
              'bash', '-c',
              [
                'npm install', 'npm run build',
                'cp -r dist/* /asset-output/',
                'cp package.json /asset-output/',
                'cd /asset-output && npm install --production',
              ].join(' && '),
            ],
          },
        },
      ),
      memorySize: 256,
      timeout: cdk.Duration.minutes(2),
      architecture: lambda.Architecture.ARM_64,
      logGroup: bedrockKeyManagerLogGroup,
      environment: {
        IAM_USER_NAME: this.bedrockApiUser.userName,
        SECRET_ID: this.bedrockApiKeySecret.secretArn,
        ALARM_TOPIC_ARN: this.agentAlarmTopic?.topicArn ?? '',
        ENVIRONMENT: environment,
      },
    });

    // Manager needs to manage the specific IAM user's credentials and write
    // the provisioned secret.
    bedrockKeyManager.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ManageBedrockUserCredentials',
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:CreateServiceSpecificCredential',
        'iam:DeleteServiceSpecificCredential',
        'iam:ListServiceSpecificCredentials',
        'iam:UpdateServiceSpecificCredential',
      ],
      resources: [this.bedrockApiUser.userArn],
    }));
    this.bedrockApiKeySecret.grantWrite(bedrockKeyManager);
    if (this.agentAlarmTopic) {
      this.agentAlarmTopic.grantPublish(bedrockKeyManager);
    }

    // Custom Resource — fires bedrockKeyManager with {RequestType: Create|Update|Delete}
    // on stack events. Provider wires up the two-step CloudFormation dance.
    const bedrockKeyProvider = new customResources.Provider(this, 'BedrockKeyProvider', {
      onEventHandler: bedrockKeyManager,
    });
    const bedrockKeyProvisioner = new cdk.CustomResource(this, 'BedrockKeyProvisioner', {
      serviceToken: bedrockKeyProvider.serviceToken,
    });
    bedrockKeyProvisioner.node.addDependency(this.bedrockApiUser);
    bedrockKeyProvisioner.node.addDependency(this.bedrockApiKeySecret);

    // Scheduled rotation — monthly
    new events.Rule(this, 'BedrockKeyRotationSchedule', {
      description: 'Monthly rotation of the Bedrock API key',
      schedule: events.Schedule.rate(cdk.Duration.days(30)),
      targets: [new eventsTargets.LambdaFunction(bedrockKeyManager, {
        event: events.RuleTargetInput.fromObject({
          source: 'psd-agent-platform',
          'detail-type': 'Scheduled Event',
          detail: { action: 'rotate' },
        }),
      })],
    });

    // Scheduled watchdog — weekly
    new events.Rule(this, 'BedrockKeyWatchdogSchedule', {
      description: 'Weekly expiry check for the Bedrock API key',
      schedule: events.Schedule.rate(cdk.Duration.days(7)),
      targets: [new eventsTargets.LambdaFunction(bedrockKeyManager, {
        event: events.RuleTargetInput.fromObject({
          source: 'psd-agent-platform',
          'detail-type': 'Scheduled Event',
          detail: { action: 'watchdog' },
        }),
      })],
    });

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

    // Read the Bedrock API key secret at container startup so the wrapper
    // can expose it to OpenClaw as AWS_BEARER_TOKEN_BEDROCK.
    this.bedrockApiKeySecret.grantRead(this.agentCoreExecutionRole);

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
        schedulesTable.tableArn,
        `${schedulesTable.tableArn}/index/*`,
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
    // for bedrock-agentcore and guardrails.
    this.routerLambdaRole = ServiceRoleFactory.createLambdaRole(this, 'RouterLambdaRole', {
      functionName: 'psd-agent-router',
      environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      dynamodbTables: [
        this.usersTable.tableName,
        this.signalsTable.tableName,
        this.messageDedupTable.tableName,
        interAgentTable.tableName,
      ],
      s3Buckets: [this.workspaceBucket.bucketName],
      // WORKAROUND: ServiceRoleFactory checks startsWith("arn:") to detect full
      // ARNs vs names. CDK cross-stack refs and new Secret() produce tokens that
      // don't start with "arn:" at synth time, causing double-wrapped ARNs.
      // Grant read access directly instead of going through the factory.
      secrets: [],
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
        // AgentCore session invoke
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AgentCoreInvoke',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:InvokeAgentRuntimeForUser'],
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

    // Grant Secrets Manager read access directly (not through ServiceRoleFactory).
    // CDK cross-stack refs and new Secret() produce tokens that don't start with
    // "arn:" at synth time, causing ServiceRoleFactory to double-wrap the ARN.
    this.googleCredentialsSecret.grantRead(this.routerLambdaRole);
    // DB secret — construct the secret from the ARN prop
    const dbSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this, 'ImportedDbSecret', props.databaseSecretArn
    );
    dbSecret.grantRead(this.routerLambdaRole);

    // 5c. Cron Lambda role — via ServiceRoleFactory
    // Note: ServiceRoleFactory grants full DynamoDB CRUD; cron only needs read.
    // Accepted tradeoff for consistency — table ARN scoping limits blast radius.
    // TODO(#887): Tighten to read-only DynamoDB when ServiceRoleFactory supports
    // granular permission levels (track as follow-up).
    // NOTE: Cron Lambda role only has access to the users table — intentionally
    // no access to the inter-agent table. The cron Lambda invokes AgentCore for
    // scheduled tasks and delivers results to DMs. Only the Router Lambda handles
    // inter-agent governance (rate limiting, anti-loop) and needs interAgentTable.
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
            actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:InvokeAgentRuntimeForUser'],
            resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`],
          })],
        }),
        // SSM Parameter Store — resolve AgentCore Runtime ID at runtime
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
        // Aurora via RDS Data API — writes run telemetry to agent_scheduled_runs.
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AuroraDataAccess',
            effect: iam.Effect.ALLOW,
            actions: ['rds-data:ExecuteStatement', 'rds-data:BatchExecuteStatement'],
            resources: [props.databaseResourceArn],
          })],
        }),
        // Database secret read for RDS Data API.
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'DatabaseSecretRead',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: [props.databaseSecretArn],
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
    // Prefer digest pinning (immutable) over tag pinning (mutable). AgentCore
    // resolves tags at deploy time but does not surface the resolved digest,
    // and we have observed stale image serving when only a tag is supplied.
    // Pass --context agentImageDigest=sha256:... for guaranteed identity.
    const imageTag = this.node.tryGetContext('agentImageTag') as string | undefined;
    const imageDigest = this.node.tryGetContext('agentImageDigest') as string | undefined;

    const artifact = imageDigest
      ? agentcore.AgentRuntimeArtifact.fromImageUri(
          `${this.ecrRepository.repositoryUri}@${imageDigest}`,
        )
      : imageTag
        ? agentcore.AgentRuntimeArtifact.fromEcrRepository(this.ecrRepository, imageTag)
        : undefined;

    if (artifact) {
      this.runtime = new agentcore.Runtime(this, 'AgentCoreRuntime', {
        runtimeName: `psd_agent_${environment}`,
        agentRuntimeArtifact: artifact,
        executionRole: this.agentCoreExecutionRole,
        // AgentCore only supports specific AZ IDs: use1-az1, use1-az2, use1-az4.
        // Our VPC includes us-east-1a (use1-az6) which is NOT supported.
        // Filter to only us-east-1b (use1-az1) and us-east-1c (use1-az2).
        // NOTE: AZ name-to-ID mapping varies per account. If deploying in a
        // different account, verify AZ IDs with: aws ec2 describe-availability-zones
        networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingVpc(this, {
          vpc,
          vpcSubnets: {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            availabilityZones: ['us-east-1b', 'us-east-1c'],
          },
        }),
        description: `PSD AI Agent Platform runtime (${environment})`,
        environmentVariables: {
          ENVIRONMENT: environment,
          WORKSPACE_BUCKET: this.workspaceBucket.bucketName,
          USERS_TABLE: this.usersTable.tableName,
          SIGNALS_TABLE: this.signalsTable.tableName,
          SCHEDULES_TABLE: schedulesTable.tableName,
          // Inputs for the psd-schedules OpenClaw skill. The skill writes
          // EventBridge Scheduler entries directly under the AgentCore role.
          // Compute ARNs / names from stable identifiers so we don't need to
          // reorder this block before the Scheduler constructs are declared;
          // CDK dependency tracking still links them through the IAM grants.
          EVENTBRIDGE_SCHEDULE_GROUP: `psd-agent-${environment}`,
          CRON_LAMBDA_ARN: `arn:aws:lambda:${this.region}:${this.account}:function:psd-agent-cron-${environment}`,
          EVENTBRIDGE_ROLE_ARN: `arn:aws:iam::${this.account}:role/psd-agent-scheduler-invoke-${environment}`,
          GUARDRAIL_ARN: props.guardrailArn,
          DATABASE_RESOURCE_ARN: props.databaseResourceArn,
          DATABASE_SECRET_ARN: props.databaseSecretArn,
          // ARN of the Secrets Manager secret holding the Bedrock API key.
          // `agentcore_wrapper.py` fetches this on startup and exports its
          // value as AWS_BEARER_TOKEN_BEDROCK so OpenClaw can authenticate
          // to Bedrock Mantle (the OpenAI-compatible endpoint). Using a
          // reference rather than embedding the secret value keeps rotation
          // seamless — new microVMs just re-read the latest version.
          BEDROCK_API_KEY_SECRET_ARN: this.bedrockApiKeySecret.secretArn,
          // Identity marker — surfaced in container startup log so we can
          // verify the running code matches the deployed image manifest.
          BUILD_MARKER: imageDigest
            ? `${imageTag ?? 'no-tag'}@${imageDigest}`
            : (imageTag ?? 'unset'),
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
    // 6b. Cedar Policies — S3 Upload
    // =====================================================================
    // Upload Cedar governance policies to the workspace bucket under policies/.
    // AgentCore reads these at session start. Policies can be updated by
    // re-uploading to S3 without redeploying the stack.

    // IMPORTANT: prune=false avoids deleting other objects under policies/, but
    // means renamed/deleted Cedar files persist in S3 indefinitely. If you rename
    // a .cedar file, manually delete the old version from S3 to prevent AgentCore
    // from loading stale policies:
    //   aws s3 rm s3://<bucket>/policies/cedar/<old-filename>.cedar
    new s3deploy.BucketDeployment(this, 'CedarPolicyDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'policies'))],
      destinationBucket: this.workspaceBucket,
      destinationKeyPrefix: 'policies/',
      prune: false,
    });

    // =====================================================================
    // 7. Cron Lambda — Per-User Scheduled Tasks
    // =====================================================================
    // Invoked by EventBridge Scheduler entries (one per user-defined schedule).
    // The Scheduler Sync Lambda (below) creates/updates/deletes those entries
    // based on DynamoDB Stream events from the schedules table.
    // This Lambda processes exactly one schedule invocation at a time — no
    // batch, no stagger, no hard cap. The agent-owner relationship is 1:1
    // between a schedule row and an EventBridge Scheduler entry.

    const cronLogGroup = new logs.LogGroup(this, 'CronLogGroup', {
      logGroupName: `/aws/lambda/psd-agent-cron-${environment}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(cronLogGroup).add('Environment', environment);
    cdk.Tags.of(cronLogGroup).add('ManagedBy', 'cdk');

    const cronLambda = new lambda.Function(this, 'CronLambda', {
      functionName: `psd-agent-cron-${environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-cron'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: lambda.Runtime.NODEJS_20_X.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'agent-cron');
                  execSync('bun install && bunx tsc', { cwd: inputDir, stdio: 'inherit' });
                  execSync(`cp -r dist/* ${outputDir}/`, { cwd: inputDir, stdio: 'inherit' });
                  execSync(`cp package.json ${outputDir}/`, { cwd: inputDir, stdio: 'inherit' });
                  execSync('bun install --production', { cwd: outputDir, stdio: 'inherit' });
                  return true;
                } catch (e) {
                  // eslint-disable-next-line no-console
                  console.error('Local bundling failed, falling back to Docker:', e);
                  return false;
                }
              },
            },
            // Docker fallback uses npm because the standard Node.js bundling image
            // does not include bun. The package.json uses only standard npm-compatible
            // deps, so dependency trees are equivalent. Local bundling (above) uses bun.
            command: [
              'bash', '-c',
              [
                'npm install', 'npm run build',
                'cp -r dist/* /asset-output/',
                'cp package.json /asset-output/',
                'cd /asset-output && npm install --production',
              ].join(' && '),
            ],
          },
        },
      ),
      memorySize: config.compute.lambdaMemory,
      // Single-user invocation: AgentCore response times observed up to 3 min
      // under load. 5 min gives ~2x headroom for tail latency. No batching or
      // stagger — one Scheduler event = one user = one Lambda invocation.
      timeout: cdk.Duration.minutes(5),
      architecture: lambda.Architecture.ARM_64,
      role: this.cronLambdaRole,
      logGroup: cronLogGroup,
      environment: {
        ENVIRONMENT: environment,
        USERS_TABLE: this.usersTable.tableName,
        GOOGLE_CREDENTIALS_SECRET_ARN: this.googleCredentialsSecret.secretArn,
        DATABASE_RESOURCE_ARN: props.databaseResourceArn,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
        DATABASE_NAME: props.databaseName ?? 'aistudio',
        AWS_ACCOUNT_ID: this.account,
      },
    });

    cdk.Tags.of(cronLambda).add('Environment', environment);
    cdk.Tags.of(cronLambda).add('ManagedBy', 'cdk');

    // Grant Cron Lambda access to Google credentials secret
    this.googleCredentialsSecret.grantRead(this.cronLambdaRole);

    // Grant Cron Lambda basic CloudWatch Logs permissions.
    // Note: SSM access for AgentCore Runtime ID lookup is provided via
    // additionalPolicies in the ServiceRoleFactory role above (SSMParameterAccess).
    this.cronLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );

    // =====================================================================
    // 7b. EventBridge Scheduler — per-user schedule entries
    // =====================================================================
    // EventBridge Scheduler (not Rules) hosts one schedule per user-defined
    // row in the AgentSchedulesTable. Scheduler supports per-entry timezone,
    // up to 1M schedules per account, and individual payloads per target —
    // all required for user-owned, independently-timed schedules.
    //
    // The Scheduler service assumes `schedulerInvokeRole` to invoke the Cron
    // Lambda. Entries are created/updated/deleted by the psd-schedules
    // OpenClaw skill running inside the agent container (no sync Lambda).

    const scheduleGroup = new scheduler.CfnScheduleGroup(this, 'AgentScheduleGroup', {
      name: `psd-agent-${environment}`,
    });
    cdk.Tags.of(scheduleGroup).add('Environment', environment);
    cdk.Tags.of(scheduleGroup).add('ManagedBy', 'cdk');

    // Role that EventBridge Scheduler assumes to invoke the Cron Lambda.
    const schedulerInvokeRole = new iam.Role(this, 'SchedulerInvokeRole', {
      roleName: `psd-agent-scheduler-invoke-${environment}`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Assumed by EventBridge Scheduler to invoke the agent cron Lambda',
    });
    cronLambda.grantInvoke(schedulerInvokeRole);

    // =====================================================================
    // 7c. Agent → EventBridge Scheduler authorization
    // =====================================================================
    // The psd-schedules OpenClaw skill runs inside the agent container and
    // writes EventBridge Scheduler entries directly under the AgentCore
    // execution role. Grant scheduler:* on the schedule group and iam:PassRole
    // on the invoke role so the skill can Create/Update/Delete schedules.
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SchedulerCrud',
      effect: iam.Effect.ALLOW,
      actions: [
        'scheduler:CreateSchedule',
        'scheduler:UpdateSchedule',
        'scheduler:DeleteSchedule',
        'scheduler:GetSchedule',
        'scheduler:ListSchedules',
      ],
      resources: [
        `arn:aws:scheduler:${this.region}:${this.account}:schedule/psd-agent-${environment}/*`,
        `arn:aws:scheduler:${this.region}:${this.account}:schedule-group/psd-agent-${environment}`,
      ],
    }));
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SchedulerPassRole',
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [schedulerInvokeRole.roleArn],
      conditions: {
        StringEquals: {
          'iam:PassedToService': 'scheduler.amazonaws.com',
        },
      },
    }));

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
      // duplicate processing. Lambda timeout is 5 min, so 30 min minimum.
      visibilityTimeout: cdk.Duration.minutes(30),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: routerDlq,
        maxReceiveCount: 3, // 3 retries before DLQ
      },
    });
    cdk.Tags.of(this.routerQueue).add('Environment', environment);
    cdk.Tags.of(this.routerQueue).add('ManagedBy', 'cdk');

    // GCP Pub/Sub → SQS bridge is implemented as an HTTP API with a Google JWT
    // authorizer and a small Lambda forwarder (see Section 9b below). The earlier
    // Workload-Identity-Federation approach in agent-platform-setup.md is a
    // dead-end: GCP Pub/Sub push only sends a Google OIDC JWT, it does not
    // perform AWS SigV4 signing, so no IAM role swap can authorize it to call
    // SQS directly.

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
          // Force asset hash from source files so CDK detects code changes.
          // Without this, CDK caches the bundled output hash and may skip
          // Lambda code updates when only TypeScript source changes.
          assetHashType: cdk.AssetHashType.SOURCE,
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
                } catch (e) {
                  // Log the error so build failures aren't silently swallowed.
                  // Docker fallback may use a different TS version, producing
                  // subtle bundle differences — surface the root cause here.
                  // eslint-disable-next-line no-console
                  console.error('Local bundling failed, falling back to Docker:', e);
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
      // Agent responses can take time. Observed >120s for fresh microVM cold
      // starts (S3 workspace pull + LLM cold path). 5 min gives headroom for
      // legitimate slow runs without hiding genuine hangs. Bumping the SQS
      // visibilityTimeout below would also need updating to stay >= 6x this
      // value if we go higher.
      timeout: cdk.Duration.minutes(5),
      architecture: lambda.Architecture.ARM_64,
      role: this.routerLambdaRole,
      logGroup: routerLogGroup,
      tracing: config.monitoring.tracingEnabled
        ? lambda.Tracing.ACTIVE
        : lambda.Tracing.DISABLED,
      environment: {
        ENVIRONMENT: environment,
        USERS_TABLE: this.usersTable.tableName,
        MESSAGE_DEDUP_TABLE: this.messageDedupTable.tableName,
        INTERAGENT_TABLE: interAgentTable.tableName,
        MAX_INTERAGENT_MESSAGES_PER_HOUR: '5',
        GUARDRAIL_ID: props.guardrailId,
        GUARDRAIL_VERSION: props.guardrailVersion || 'DRAFT',
        DATABASE_HOST: props.databaseHost,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
        DATABASE_NAME: props.databaseName || 'aistudio',
        GOOGLE_CREDENTIALS_SECRET_ARN: this.googleCredentialsSecret.secretArn,
        TOKEN_LIMIT_PER_INTERACTION: '100000',
        // K-12 safety: fail closed when guardrails are unavailable
        GUARDRAIL_FAIL_OPEN: 'false',
        // Only allow messages from configured domain emails
        ALLOWED_DOMAINS: props.allowedDomains || 'psd401.net',
        // Account ID needed to construct AgentCore Runtime ARN from the runtime ID
        AWS_ACCOUNT_ID: this.account,
        NODE_ENV: 'production',
        // AGENTCORE_RUNTIME_ID is intentionally NOT set here — it is resolved
        // from SSM at runtime because the Runtime resource is conditionally
        // created only when an image tag is provided via CDK context.
        //
        // AGENT_BUILD_TAG — short stable identifier for the deployed AgentCore
        // image. Mixed into the AgentCore session ID so every deploy
        // invalidates sticky-routed microVMs. Without this, AgentCore happily
        // serves an existing user's session from a microVM running an OLD
        // image until idleRuntimeSessionTimeout, which can be hours for an
        // active user — a real correctness/security risk at scale. Empty
        // string is fine; it just means we did not pin a digest this deploy.
        AGENT_BUILD_TAG: imageDigest
          ? imageDigest.replace('sha256:', '').substring(0, 12)
          : (imageTag ?? ''),
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
        // Enable partial batch failure reporting — Lambda returns which records
        // failed so only those are retried. Prevents duplicate Google Chat messages
        // for records that already succeeded. Safe at any batch size.
        reportBatchItemFailures: true,
      }),
    );

    // =====================================================================
    // 9b. GCP Pub/Sub → SQS Bridge (HTTP API + JWT Authorizer + Lambda)
    // =====================================================================
    // GCP Pub/Sub push subscriptions deliver messages over HTTPS with a Google
    // OIDC ID token in the Authorization header. They cannot SigV4-sign for
    // SQS, so we expose a public HTTPS endpoint that:
    //   1. Validates the JWT via API Gateway's built-in authorizer
    //      (issuer = https://accounts.google.com, audience = the API URL)
    //   2. Forwards the raw Pub/Sub envelope to the Router SQS queue via a
    //      tiny Lambda (HTTP API has no native SQS service integration)
    //
    // To enable: pass --context gcpPubsubAudience=<url> (the URL the Pub/Sub
    // push subscription is configured to call). Setting this to the API URL
    // itself is the simplest correct value.

    const gcpPubsubAudience = this.node.tryGetContext('gcpPubsubAudience') as string | undefined;

    const bridgeLogGroup = new logs.LogGroup(this, 'ChatBridgeLogGroup', {
      logGroupName: `/aws/lambda/psd-agent-chat-bridge-${environment}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const bridgeLambda = new lambda.Function(this, 'ChatBridgeLambda', {
      functionName: `psd-agent-chat-bridge-${environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-chat-bridge'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: lambda.Runtime.NODEJS_20_X.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'agent-chat-bridge');
                  execSync('bun install && bunx tsc', { cwd: inputDir, stdio: 'inherit' });
                  execSync(`cp -r dist/* ${outputDir}/`, { cwd: inputDir, stdio: 'inherit' });
                  execSync(`cp package.json ${outputDir}/`, { cwd: inputDir, stdio: 'inherit' });
                  execSync('bun install --production', { cwd: outputDir, stdio: 'inherit' });
                  return true;
                } catch (e) {
                  // eslint-disable-next-line no-console
                  console.error('Local bundling failed, falling back to Docker:', e);
                  return false;
                }
              },
            },
            command: [
              'bash', '-c',
              [
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
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      architecture: lambda.Architecture.ARM_64,
      logGroup: bridgeLogGroup,
      environment: {
        ROUTER_QUEUE_URL: this.routerQueue.queueUrl,
      },
    });
    this.routerQueue.grantSendMessages(bridgeLambda);
    cdk.Tags.of(bridgeLambda).add('Environment', environment);
    cdk.Tags.of(bridgeLambda).add('ManagedBy', 'cdk');

    const chatHttpApi = new apigwv2.HttpApi(this, 'ChatBridgeApi', {
      apiName: `psd-agent-chat-bridge-${environment}`,
      description: 'Receives Google Chat Pub/Sub push deliveries and forwards them to SQS',
    });

    // JWT authorizer — only valid Google-signed tokens whose audience matches
    // the configured value are accepted. If audience is not yet configured,
    // skip authorizer wiring; the route below will then 401 every request,
    // which is the safe default (no anonymous access).
    if (gcpPubsubAudience) {
      // Google Pub/Sub signs the OIDC token's `aud` field with the push
      // subscription's configured audience. Depending on how the
      // subscription is set up, this may be either the API origin
      // (https://<api-id>.execute-api.<region>.amazonaws.com) OR the full
      // push endpoint URL (https://<api-id>...amazonaws.com/chat). We accept
      // both so a redeploy cannot silently lock out Pub/Sub by narrowing the
      // audience — real outage 2026-04-20, restored via live authorizer
      // patch + this widened list.
      const stripped = gcpPubsubAudience.replace(/\/chat\/*$/, '');
      const withPath = stripped.endsWith('/chat')
        ? stripped
        : `${stripped.replace(/\/$/, '')}/chat`;
      const acceptedAudiences = Array.from(new Set([
        gcpPubsubAudience,
        stripped,
        withPath,
      ]));

      const jwtAuthorizer = new apigwv2Authorizers.HttpJwtAuthorizer(
        'ChatBridgeJwtAuthorizer',
        'https://accounts.google.com',
        {
          jwtAudience: acceptedAudiences,
          identitySource: ['$request.header.Authorization'],
        },
      );

      chatHttpApi.addRoutes({
        path: '/chat',
        methods: [apigwv2.HttpMethod.POST],
        integration: new apigwv2Integrations.HttpLambdaIntegration(
          'ChatBridgeIntegration',
          bridgeLambda,
        ),
        authorizer: jwtAuthorizer,
      });
    }

    new cdk.CfnOutput(this, 'ChatBridgeEndpoint', {
      value: gcpPubsubAudience
        ? `${chatHttpApi.apiEndpoint}/chat`
        : 'NOT CONFIGURED — pass --context gcpPubsubAudience=<https-url> (set this to the API endpoint URL itself), then redeploy. Update Pub/Sub push subscription endpoint + audience to match.',
      description: 'Google Chat Pub/Sub push endpoint URL',
    });

    // Alarm topic is created in section 4d (needed early for the Bedrock
    // key manager's watchdog). Reuse it here for Router/DLQ alerts.
    const alarmTopic = this.agentAlarmTopic;

    // CloudWatch alarm on the DLQ — fires when any message lands in the dead-letter
    // queue, meaning a user's message was silently dropped after 3 retries. In a K-12
    // environment this warrants immediate investigation.
    const dlqAlarm = new cloudwatch.Alarm(this, 'RouterDlqAlarm', {
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

    // Lambda error rate alarm — catches transient errors (e.g., Google Chat API 5xx)
    // that succeed on retry and never reach the DLQ. Without this, invisible failures
    // go undetected. Fires if ≥5 errors in a 5-minute window.
    const errorAlarm = new cloudwatch.Alarm(this, 'RouterLambdaErrorAlarm', {
      alarmName: `psd-agent-router-errors-${environment}`,
      alarmDescription: 'Agent Router Lambda error rate elevated — investigate transient failures',
      metric: this.routerLambda.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Wire alarm notifications if SNS topic is configured
    if (alarmTopic) {
      const snsAction = new cloudwatchActions.SnsAction(alarmTopic);
      dlqAlarm.addAlarmAction(snsAction);
      errorAlarm.addAlarmAction(snsAction);
    }

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
      new ssm.StringParameter(this, 'CronLambdaArnParam', {
        parameterName: `/aistudio/${environment}/agent-cron-lambda-arn`,
        stringValue: cronLambda.functionArn,
        description: 'Cron Lambda function ARN',
      }),
      new ssm.StringParameter(this, 'InterAgentTableNameParam', {
        parameterName: `/aistudio/${environment}/agent-interagent-table-name`,
        stringValue: interAgentTable.tableName,
        description: 'DynamoDB table name for inter-agent communication tracking',
      }),
      new ssm.StringParameter(this, 'SchedulesTableNameParam', {
        parameterName: `/aistudio/${environment}/agent-schedules-table-name`,
        stringValue: schedulesTable.tableName,
        description: 'DynamoDB table name for user-defined agent schedules',
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

    new cdk.CfnOutput(this, 'CronLambdaArn', {
      value: cronLambda.functionArn,
      description: 'Cron Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'InterAgentTableName', {
      value: interAgentTable.tableName,
      description: 'DynamoDB table for inter-agent communication tracking',
    });
  }
}
