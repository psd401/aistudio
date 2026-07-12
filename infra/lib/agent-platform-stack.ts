import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
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
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
// ALPHA CDK CONSTRUCT: @aws-cdk/aws-bedrock-agentcore-alpha has no API stability
// guarantee and may introduce breaking changes on any release. Version is pinned
// (not caret) in infra/package.json. Review changelog before upgrading.
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import {
  VPCProvider,
  IEnvironmentConfig,
} from './constructs';
import { ServiceRoleFactory, usGuardrailProfileArns } from './constructs/security';
import { AGENT_LAMBDA_RUNTIME } from './constructs/compute/lambda-construct';

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
  /**
   * Base URL of the Next.js app (e.g. `https://dev.aistudio.psd401.ai`).
   * Used by the psd-workspace skill (#912) to call /api/agent/consent-link.
   * Optional for backwards-compat; the skill fails closed with a clear error
   * if the caller tries to mint a consent URL without this set.
   */
  appBaseUrl?: string;
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
  public readonly sessionLocksTable: dynamodb.Table;
  /** DynamoDB table for per-user email triage state (Phase 1 of email triage feature) */
  public readonly triageTable: dynamodb.Table;
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

    // Lambda function names as constants — referenced by both the
    // runtimeEnvVars block (line ~1167) and the Lambda definitions below.
    // Prevents silent breakage if a function name ever changes.
    const triageDigestFunctionName = `psd-agent-triage-digest-${environment}`;
    const cronFunctionName = `psd-agent-cron-${environment}`;
    const skillBuilderFunctionName = `psd-agent-skill-builder-${environment}`;

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
      // BlockPublicAcls + IgnorePublicAcls keep ACL-driven public access
      // forbidden. BlockPublicPolicy and RestrictPublicBuckets are FALSE so
      // the resource policy below can grant unauthenticated GetObject on
      // the single `public-images/*` prefix used by the psd-image-gen
      // skill. Without this carve-out the skill returns presigned URLs
      // signed with AgentCore's STS session credentials; those URLs embed
      // an `X-Amz-Security-Token` query parameter that intermittently
      // fails with `InvalidToken` when fetched through chat clients
      // (observed in PR #934 dev rollout 2026-05-03). Switching to a
      // public-by-link prefix eliminates the failure mode entirely.
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
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

    // Public-read carve-out for psd-image-gen output. Skill writes generated
    // PNGs to `public-images/<email>/<uuid>.png` and returns an unsigned
    // HTTPS URL. The UUID makes the path unguessable; anyone who receives
    // the URL can fetch — same security model as Google Drive "anyone with
    // the link" sharing. The skill, IAM grants, and this policy must all
    // agree on the `public-images/` prefix. Other prefixes in the bucket
    // remain private (no other allow-public statements exist).
    this.workspaceBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'PublicReadOnPublicImagesPrefix',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject'],
      resources: [`${this.workspaceBucket.bucketArn}/public-images/*`],
    }));

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

    // GSI on email for cross-user agent invocation (@agent:username resolution)
    // and schedule identity self-heal (resolving googleIdentity from email)
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'email-index',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
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

    // 4c-bis. Session Locks table — serializes concurrent invocations against
    // the same AgentCore session ID. AgentCore sticky-routes by session ID, so
    // two messages from the same user/space hit the same OpenClaw turn loop.
    // Without serialization, message #2 lands while #1 is mid-turn and gets
    // an empty response ("I processed your message but had no response.").
    // The router takes this lock before InvokeAgentRuntime and releases after.
    // TTL is a backstop: if a Lambda dies holding the lock, the row expires
    // ~14 min later (just under Lambda's 15-min timeout) so the next message
    // can proceed.
    this.sessionLocksTable = new dynamodb.Table(this, 'AgentSessionLocksTable', {
      tableName: `psd-agent-session-locks-${environment}`,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(this.sessionLocksTable).add('Environment', environment);
    cdk.Tags.of(this.sessionLocksTable).add('ManagedBy', 'cdk');

    // 4c-bis. Email Triage table — per-user state for the smart email
    // triage feature (Phase 1). One row per user; the row exists whether
    // or not the user has opted in (created lazily on first enable).
    //
    // Attributes (not enforced at the table level, but the consumer
    // expects):
    //   userEmail            string  (PK)
    //   enabled              bool
    //   enabledAt/disabledAt ISO ts
    //   classifierStartHistoryId string  (Gmail history cursor at enable)
    //   lastHistoryId        string  (cursor, updated every poll)
    //   lastPollAt           ISO ts
    //   labels               map<key,string>   (e.g. important → "@psd/Important")
    //   labelIdsByKey        map<key,string>   (Gmail label IDs, cached)
    //   rules                map<…>
    //   escalation           map<…>
    //   digestEnabled        bool
    //   digestTime           "HH:MM"
    //   digestTz             IANA tz
    //   digestScheduleArn    string  (EventBridge Scheduler entry, for delete)
    //   recentDecisions      list<map> (rolling 20)
    //   recentCorrections    list<map> (rolling 20)
    //   learnedPatterns      list<map> (populated in Phase 2)
    //
    // PITR ON: rules are user-curated and learned patterns accumulate over
    // weeks — losing them on accidental table deletion would be a real
    // regression. Pay-per-request keeps cost negligible at single-user
    // scale and elastic for the planned 1000-user rollout.
    this.triageTable = new dynamodb.Table(this, 'AgentEmailTriageTable', {
      tableName: `psd-agent-triage-${environment}`,
      partitionKey: { name: 'userEmail', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(this.triageTable).add('Environment', environment);
    cdk.Tags.of(this.triageTable).add('ManagedBy', 'cdk');

    // 4d. Inter-Agent Communication table — tracks agent-to-agent messages
    // for rate limiting and anti-loop detection. Uses TTL for automatic cleanup.
    // PITR enabled: this is an audit trail for governance enforcement, so
    // accidental table deletion should be recoverable even though TTL
    // expires individual rows after 2 hours.
    const interAgentTable = new dynamodb.Table(this, 'AgentInterAgentTable', {
      tableName: `psd-agent-interagent-${environment}`,
      partitionKey: { name: 'senderBotId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sentAt', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
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
              // Cross-region inference profiles (us.*) authorize against the
              // DESTINATION region's foundation-model ARN — grant all three
              // regions the us.* profiles span (same lesson as the guardrail
              // profile, #1138).
              `arn:aws:bedrock:us-east-1::foundation-model/*`,
              `arn:aws:bedrock:us-east-2::foundation-model/*`,
              `arn:aws:bedrock:us-west-2::foundation-model/*`,
              `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
            ],
          }),
          new iam.PolicyStatement({
            sid: 'ListModels',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:ListFoundationModels', 'bedrock:GetFoundationModel'],
            resources: ['*'],
          }),
          // memory_search in OpenClaw >= 2026.4 uses bedrock:CallWithBearerToken
          // to generate embeddings for semantic search over the agent's local
          // ~/.openclaw/memory/ files. Without this action the tool returns
          // "embedding/provider error" and memories become unsearchable.
          // Per-user scoping note: this is a single shared service credential,
          // but memory files are per-user by construction (workspace_sync.py
          // syncs only the caller's S3 workspace prefix into the container).
          // No cross-user leakage via this grant — embeddings are generated
          // from text the agent has already loaded from its own workspace.
          new iam.PolicyStatement({
            sid: 'BedrockEmbeddingsViaBearerToken',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:CallWithBearerToken'],
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

    // =====================================================================
    // 4e. Google Workspace OAuth client credentials (#912)
    // =====================================================================
    // Stores the GCP OAuth client_id + client_secret used by the agent
    // workspace consent flow (/agent-connect). Populated manually after GCP
    // Console setup:
    //   aws secretsmanager put-secret-value \
    //     --secret-id psd-agent/<env>/google-oauth-client \
    //     --secret-string '{"client_id":"...","client_secret":"..."}'
    const googleOAuthClientSecret = new secretsmanager.Secret(this, 'GoogleOAuthClientSecret', {
      secretName: `psd-agent/${environment}/google-oauth-client`,
      description: `Google Workspace OAuth client credentials for agent consent flow. Populate after GCP Console setup. Issue #912.`,
    });
    cdk.Tags.of(googleOAuthClientSecret).add('Environment', environment);
    cdk.Tags.of(googleOAuthClientSecret).add('ManagedBy', 'cdk');

    // Plaud OAuth client (public, PKCE) for the /agent-connect-plaud consent
    // flow + the psd-plaud skill. Created EMPTY — the app auto-registers a
    // client via Plaud's Dynamic Client Registration on first consent (using
    // its own issuer URL as redirect_uri, so it's always correct per env) and
    // writes the client_id here. No manual step. See ensurePlaudClientId in
    // actions/agent-plaud.actions.ts; the ECS task role is granted PutSecretValue
    // on this specific secret in ecs-service.ts.
    const plaudOAuthClientSecret = new secretsmanager.Secret(this, 'PlaudOAuthClientSecret', {
      secretName: `psd-agent/${environment}/plaud-oauth-client`,
      description: `Plaud OAuth public client_id — auto-registered by the app (DCR) on first consent.`,
    });
    cdk.Tags.of(plaudOAuthClientSecret).add('Environment', environment);
    cdk.Tags.of(plaudOAuthClientSecret).add('ManagedBy', 'cdk');

    // Canva Connect OAuth client credentials (#1176) for the
    // /agent-connect-canva consent flow + the psd-canva skill. Canva is a
    // CONFIDENTIAL client — unlike Plaud there is no Dynamic Client
    // Registration. Created EMPTY (Google pattern); populated after deploy with
    // the client_id + client_secret from the Canva Developer Portal:
    //   aws secretsmanager put-secret-value \
    //     --secret-id psd-agent/<env>/canva-oauth-client \
    //     --secret-string '{"client_id":"...","client_secret":"..."}'
    // Read (not written) by the ECS web app + the AgentCore runtime, both of
    // which already hold GetSecretValue on psd-agent/${environment}/* — so no
    // new IAM grant is required.
    const canvaOAuthClientSecret = new secretsmanager.Secret(this, 'CanvaOAuthClientSecret', {
      secretName: `psd-agent/${environment}/canva-oauth-client`,
      description: `Canva Connect OAuth confidential client credentials for agent consent flow. Populate after Canva Developer Portal setup. Issue #1176.`,
    });
    cdk.Tags.of(canvaOAuthClientSecret).add('Environment', environment);
    cdk.Tags.of(canvaOAuthClientSecret).add('ManagedBy', 'cdk');

    // Atrium content API key (#1055 Path 2) for the psd-atrium skill. A scoped
    // `sk-` key holding content: scopes (content:read/create/update/
    // publish_internal). Created empty, then AUTO-POPULATED on every deploy by
    // the AtriumContentKeyBootstrapLambda custom resource (section 4g below),
    // which idempotently mints the key for the migration-104 service user —
    // DO NOT populate it manually; a hand-written value is detected as
    // stale/unowned and replaced on the next deploy. Rotation: clear the secret
    // value or revoke the api_keys row, then deploy.
    // Read (not written) by the AgentCore runtime, which already holds
    // GetSecretValue on psd-agent/${environment}/* (see the execution-role policy
    // below) — so no new IAM grant is required. The value is a RAW sk- string,
    // NOT JSON (the skill reads SecretString verbatim).
    const atriumContentApiKeySecret = new secretsmanager.Secret(this, 'AtriumContentApiKeySecret', {
      secretName: `psd-agent/${environment}/atrium-content-api-key`,
      description: `Scoped sk- content API key for the psd-atrium skill (Atrium /api/v1/content access). AUTO-POPULATED each deploy by AtriumContentKeyBootstrapLambda — do not set manually. Issue #1055.`,
    });
    cdk.Tags.of(atriumContentApiKeySecret).add('Environment', environment);
    cdk.Tags.of(atriumContentApiKeySecret).add('ManagedBy', 'cdk');

    // 4f. Internal API key for agent→Next.js consent-link endpoint (#912)
    // Pre-shared secret the agent runtime sends as Bearer token to POST
    // /api/agent/consent-link. Auto-generated by CDK.
    const agentInternalApiKeySecret = new secretsmanager.Secret(this, 'AgentInternalApiKeySecret', {
      secretName: `psd-agent/${environment}/internal-api-key`,
      description: `Pre-shared secret for agent-to-Next.js consent-link API authentication. Issue #912.`,
      generateSecretString: {
        excludePunctuation: true,
        includeSpace: false,
        passwordLength: 48,
      },
    });
    cdk.Tags.of(agentInternalApiKeySecret).add('Environment', environment);
    cdk.Tags.of(agentInternalApiKeySecret).add('ManagedBy', 'cdk');

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

    // Shared dead-letter queue for the async-invoked agent Lambdas (EventBridge
    // Rules/Scheduler, custom-resource invoke, cross-Lambda async invoke). Without it
    // a failed async invocation is retried twice by Lambda and then DROPPED with no
    // trace — silently losing key rotations, scheduled crons, digests, and the
    // health/prune/pattern/nonce scans (REV-INFRA-128). One queue + one alarm.
    const agentAsyncDlq = new sqs.Queue(this, 'AgentAsyncDLQ', {
      queueName: `psd-agent-async-dlq-${environment}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    cdk.Tags.of(agentAsyncDlq).add('Environment', environment);
    cdk.Tags.of(agentAsyncDlq).add('ManagedBy', 'cdk');

    const agentAsyncDlqAlarm = new cloudwatch.Alarm(this, 'AgentAsyncDlqAlarm', {
      alarmName: `psd-agent-async-dlq-${environment}`,
      alarmDescription:
        'Async agent Lambda DLQ received messages — a scheduled/async invocation failed and was dropped',
      metric: agentAsyncDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    if (this.agentAlarmTopic) {
      agentAsyncDlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.agentAlarmTopic));
    }

    const bedrockKeyManagerLogGroup = new logs.LogGroup(this, 'BedrockKeyManagerLogGroup', {
      logGroupName: `/aws/lambda/psd-agent-bedrock-key-manager-${environment}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const bedrockKeyManager = new lambda.Function(this, 'BedrockKeyManagerLambda', {
      deadLetterQueue: agentAsyncDlq, // async-invoke failures → DLQ + alarm (REV-INFRA-128)
      functionName: `psd-agent-bedrock-key-manager-${environment}`,
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'bedrock-api-key-manager'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: AGENT_LAMBDA_RUNTIME.bundlingImage,
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
    // 4g. Atrium content API key — deploy-time zero-touch provisioning
    // =====================================================================
    // Removes the two manual steps PR #1195 left behind (mint an `sk-` key in
    // AI Studio Settings + `aws secretsmanager put-secret-value`). This custom
    // resource idempotently ensures `atriumContentApiKeySecret` (created above)
    // holds a valid, active, content-scoped key owned by the service user seeded
    // by migration 104 (`cognito_sub = service-account:psd-atrium-agent`).
    //
    //   - Reuses the repo's Aurora deploy pattern: the RDS Data API
    //     (rds-data:ExecuteStatement/BatchExecuteStatement, same as the db-init
    //     migration Lambda, plus BeginTransaction/CommitTransaction/
    //     RollbackTransaction for the revoke+insert replace transaction).
    //   - Argon2id-hashes the key with hash-wasm using the SAME params as the
    //     app's argon2 loader, so `validateApiKey` authenticates it unchanged.
    //     The DB stores only the hash; the plaintext goes to the secret and is
    //     never logged.
    //   - Idempotent: no-op when the secret already holds a valid key; re-mints
    //     when the secret is empty/stale or the key is revoked/scope-drifted
    //     (exact scope match — a scope REDUCTION also re-mints).
    //   - Runs AFTER DatabaseStack (bin/infra.ts addDependency), so migration
    //     104 (the service user) has been applied before it mints. That ordering
    //     only holds for `cdk deploy --all`; a partial single-stack deploy
    //     against a cluster missing migration 104 does NOT fail the stack — the
    //     Lambda logs an error and reports Outcome=skipped-migration-pending
    //     (a CFN FAILED would roll back, and could wedge, this entire shared
    //     stack). The next full deploy self-heals via the per-deploy Nonce.
    //
    // Least-privilege role (ServiceRoleFactory): RDS Data API on the cluster +
    // read the DB credential secret + read/write ONLY the content-key secret.
    // Secrets are granted directly via additionalPolicies (not the factory's
    // `secrets` array) to avoid the token double-wrap on cross-stack ARNs.
    const atriumKeyBootstrapRole = ServiceRoleFactory.createLambdaRole(this, 'AtriumContentKeyBootstrapRole', {
      functionName: 'psd-agent-atrium-key-bootstrap',
      environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      // The account-wide AIStudio-PermissionBoundary allows secretsmanager
      // READS only — it cannot express this role's one write duty
      // (PutSecretValue on exactly the content-key secret), and the first
      // deploy failed on precisely that denial. Opt out of the boundary
      // (the AgentCore execution role precedent for secret-writing roles);
      // the identity policies below remain the sole grant and are exact-ARN.
      enablePermissionBoundary: false,
      secrets: [],
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'AuroraDataApi',
              effect: iam.Effect.ALLOW,
              actions: [
                'rds-data:ExecuteStatement',
                'rds-data:BatchExecuteStatement',
                'rds-data:BeginTransaction',
                'rds-data:CommitTransaction',
                'rds-data:RollbackTransaction',
              ],
              resources: [props.databaseResourceArn],
            }),
            new iam.PolicyStatement({
              sid: 'ReadDatabaseSecret',
              effect: iam.Effect.ALLOW,
              actions: ['secretsmanager:GetSecretValue'],
              resources: [props.databaseSecretArn],
            }),
            new iam.PolicyStatement({
              sid: 'ReadWriteContentKeySecret',
              effect: iam.Effect.ALLOW,
              actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
              resources: [atriumContentApiKeySecret.secretArn],
            }),
          ],
        }),
      ],
    });

    const atriumKeyBootstrapLogGroup = new logs.LogGroup(this, 'AtriumContentKeyBootstrapLogGroup', {
      logGroupName: `/aws/lambda/psd-agent-atrium-key-bootstrap-${environment}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const atriumKeyBootstrap = new lambda.Function(this, 'AtriumContentKeyBootstrapLambda', {
      functionName: `psd-agent-atrium-key-bootstrap-${environment}`,
      role: atriumKeyBootstrapRole,
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'atrium-content-key-bootstrap'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: AGENT_LAMBDA_RUNTIME.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'atrium-content-key-bootstrap');
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
      // 512 MB: Argon2id reserves 64 MB for the hash itself atop the Node/WASM
      // baseline — 256 left thin headroom, and an OOM mid-mint is exactly the
      // crash the transactional replace exists to survive. 5 min: dev Aurora
      // auto-pauses to 0 ACU; a cold resume can exceed the old 2-min budget.
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      architecture: lambda.Architecture.ARM_64,
      logGroup: atriumKeyBootstrapLogGroup,
      environment: {
        DB_CLUSTER_ARN: props.databaseResourceArn,
        DB_SECRET_ARN: props.databaseSecretArn,
        DB_NAME: props.databaseName ?? 'aistudio',
        CONTENT_KEY_SECRET_ID: atriumContentApiKeySecret.secretArn,
        SERVICE_USER_COGNITO_SUB: 'service-account:psd-atrium-agent',
        // Key name + scopes live as constants in the Lambda (single source of
        // truth, unit-tested against ROLE_SCOPES.staff — see index.ts KEY_SCOPES).
      },
    });

    const atriumKeyProvider = new customResources.Provider(this, 'AtriumContentKeyProvider', {
      onEventHandler: atriumKeyBootstrap,
    });
    const atriumKeyProvisioner = new cdk.CustomResource(this, 'AtriumContentKeyProvisioner', {
      serviceToken: atriumKeyProvider.serviceToken,
      properties: {
        // Bump on every synth so the custom resource's Update handler fires on
        // EVERY deploy. The ensure logic is idempotent (a no-op when the key is
        // valid), so re-running is cheap; the benefit is self-healing — a
        // cleared secret or revoked key row is re-minted on the next deploy,
        // which is exactly the documented rotation story.
        Nonce: Date.now().toString(),
      },
    });
    atriumKeyProvisioner.node.addDependency(atriumContentApiKeySecret);

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
        // Cross-region us.* profiles authorize against the DESTINATION
        // region's foundation-model ARN (verified live for the guardrail
        // profile, #1138) — grant all three regions the profiles span.
        `arn:aws:bedrock:us-east-1::foundation-model/*`,
        `arn:aws:bedrock:us-east-2::foundation-model/*`,
        `arn:aws:bedrock:us-west-2::foundation-model/*`,
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

    // S3 workspace read/write. PutObjectTagging is required because the
    // psd-skills-meta skill's authorSkill() writes objects with a Tagging=
    // header (scope, environment, owner) so the skill-builder Lambda can
    // scope tag-based policies later.
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3WorkspaceAccess',
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:GetObjectVersion',
        's3:PutObject',
        's3:PutObjectTagging',
        's3:DeleteObject',
        's3:ListBucket',
        's3:GetBucketLocation',
      ],
      resources: [
        this.workspaceBucket.bucketArn,
        `${this.workspaceBucket.bucketArn}/*`,
      ],
    }));

    // Amazon Polly text-to-speech (psd-tts skill). Polly is NOT Bedrock — it
    // authenticates via this execution role's standard SigV4 credential chain,
    // NOT the AWS_BEARER_TOKEN_BEDROCK token used for model invocation. The
    // skill uses only the synchronous SynthesizeSpeech API (it chunks long text
    // and concatenates the MP3s), so we grant exactly that action and nothing
    // else. SynthesizeSpeech does not support resource-level permissions, so the
    // resource must be '*'. Synthesized MP3s are written to the workspace bucket
    // by the skill using the S3WorkspaceAccess grant above (public-images/ prefix).
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PollyTextToSpeech',
      effect: iam.Effect.ALLOW,
      actions: ['polly:SynthesizeSpeech'],
      resources: ['*'],
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
      // The guardrail uses cross-region inference (guardrails-stack.ts
      // crossRegionConfig), so ApplyGuardrail authorizes against BOTH the
      // guardrail ARN AND the system-defined guardrail-profile ARN in the
      // DESTINATION region Bedrock routes to — a FIXED US fan-out set, not
      // this.region. Granting one region yields AccessDenied whenever routing
      // leaves it (issue #1138 F5). Profile id stays pinned.
      resources: [
        props.guardrailArn,
        ...usGuardrailProfileArns(this.account),
      ],
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
        // Email triage state (Phase 1) — agent skill reads/writes per-user
        // rules, label IDs, escalation lists, and recent decisions/corrections.
        this.triageTable.tableArn,
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

    // CloudWatch custom metrics — harness emits PSD/AgentPlatform/{env}/AgentFailuresHarness
    // via boto3 put_metric_data. Resource must be '*' per AWS API contract; we
    // scope by namespace condition.
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchMetricsPublish',
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': `PSD/AgentPlatform/${environment}`,
        },
      },
    }));

    // Secrets Manager — read DB credentials referenced by DATABASE_SECRET_ARN
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SecretsManagerAccess',
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.databaseSecretArn],
    }));

    // Secrets Manager — psd-credentials skill (#910): read shared + per-user
    // agent credentials and list them by prefix.
    //
    // SECURITY NOTE: Per-user isolation is currently enforced at the application
    // layer (psd-credentials skill resolves the user's email from the --user arg
    // injected by the AgentCore runtime). The IAM policy below is scoped to the
    // psd-agent-creds namespace but does not enforce per-user boundaries via tags.
    //
    // Future hardening: Add tag-based conditions (CredentialScope + Owner tags)
    // once the secret provisioning workflow supports tagging at creation time
    // and ECS task sessions carry per-user principal tags. This requires:
    //   1. Secrets tagged with CredentialScope=shared|user and Owner=<email>
    //   2. ECS task role sessions tagged with Owner=<authenticated-email>
    //   3. IAM conditions: aws:ResourceTag/Owner = ${aws:PrincipalTag/Owner}
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCredentialsRead',
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:psd-agent-creds/${environment}/*`,
      ],
    }));

    // ListSecrets does not support resource-level permissions — must use '*'
    // with name-prefix filtering in the application layer.
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCredentialsList',
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:ListSecrets'],
      resources: ['*'],
    }));

    // Per-user credential WRITE — for the psd-credentials/put.js helper.
    // Scope is intentionally locked to the per-user prefix
    // (psd-agent-creds/{env}/user/*) so a skill cannot write or rotate
    // a shared (district-wide) secret. Shared-scope provisioning stays
    // an admin-only operation done out of band.
    //
    // CreateSecret and TagResource are constrained by aws:RequestTag
    // conditions matching what psd-credentials/put.js sets on new secrets.
    // This prevents a compromised task from re-tagging existing per-user
    // secrets with arbitrary Environment or ManagedBy values.
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCredentialsWritePerUser',
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:CreateSecret',
        'secretsmanager:TagResource',
      ],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:psd-agent-creds/${environment}/user/*`,
      ],
      conditions: {
        StringEquals: {
          'aws:RequestTag/Environment': environment,
          'aws:RequestTag/ManagedBy': 'psd-credentials-skill',
        },
        'ForAllValues:StringEquals': {
          'aws:TagKeys': ['Environment', 'ManagedBy', 'Scope'],
        },
      },
    }));

    // PutSecretValue does not support tag conditions — it only updates
    // the secret value, not tags. Scoped to the per-user resource prefix.
    //
    // KNOWN LIMITATION (AWS API): PutSecretValue cannot be scoped to a
    // single user's email path because the action does not support
    // aws:RequestTag/* or aws:ResourceTag/* conditions. This means any
    // skill running on the AgentCore task can rotate any user's credential
    // under the `psd-agent-creds/{env}/user/*` prefix. Compensating
    // controls: (1) skills validate --user is the authenticated caller,
    // (2) psd_agent_credentials_audit logs all writes with action/email,
    // (3) the ECS task is isolated per-session. This is not a gap in our
    // design — it is a Secrets Manager API constraint.
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentCredentialsUpdatePerUser',
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:PutSecretValue',
      ],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:psd-agent-creds/${environment}/user/*`,
      ],
    }));

    // Secrets Manager — psd-workspace skill (#912): read shared OAuth client
    // credentials and the internal API key for consent-link generation.
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentWorkspaceSecretsRead',
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:psd-agent/${environment}/*`,
      ],
    }));

    // Lambda invoke — psd-skills-meta skill triggers the Skill Builder
    // Lambda asynchronously (InvocationType: Event) for draft scanning.
    this.agentCoreExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SkillBuilderLambdaInvoke',
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [
        `arn:aws:lambda:${this.region}:${this.account}:function:${skillBuilderFunctionName}`,
      ],
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
        this.sessionLocksTable.tableName,
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
            // Cross-region inference (guardrails-stack.ts crossRegionConfig)
            // makes ApplyGuardrail authorize against BOTH the guardrail ARN
            // and the system-defined guardrail-profile ARN in the DESTINATION
            // region Bedrock routes to. Scoping to this.region caused
            // AccessDenied on 100% of router turns routed to us-east-2
            // (issue #1138 F5); grant the whole fixed US fan-out set.
            resources: [
              props.guardrailArn,
              ...usGuardrailProfileArns(this.account),
            ],
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

    // Attachment delivery (#1138 F1): the router writes Chat-upload bytes to
    // s3://<workspace-bucket>/<workspacePrefix>/attachments/. This CANNOT rely
    // on the ServiceRoleFactory s3Buckets grant above — that grant conditions
    // object actions on `aws:ResourceTag/Environment|ManagedBy`, and S3 object
    // operations provide NO resource tags at authorization time (the bucket's
    // tags do not satisfy the key, despite the factory comment claiming they
    // do), so every s3:PutObject through it is denied. Observed live:
    // AccessDenied on .../attachments/...pdf, 2026-07-07 (#1138 follow-up).
    // Grant the write narrowly (attachments keys only) without the inert
    // condition. AbortMultipartUpload lets lib-storage clean up a failed
    // multipart upload instead of leaving orphaned parts.
    this.routerLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'WorkspaceAttachmentWrite',
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
      resources: [`${this.workspaceBucket.bucketArn}/*/attachments/*`],
    }));

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

    // ServiceRoleFactory builds its inline logs ARN as
    // /aws/lambda/${functionName}:* with functionName='psd-agent-cron', but the
    // real log group is /aws/lambda/psd-agent-cron-${environment}. The ARN
    // mismatch silently denied CreateLogStream/PutLogEvents starting Apr 24,
    // 2026. Narrow inline policy targeting the actual log group instead of the
    // overly broad AWSLambdaBasicExecutionRole managed policy.
    this.cronLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CronLambdaLogsCorrectArn',
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${cronFunctionName}:*`,
        ],
      }),
    );

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

    // Runtime environment variables shared by the AgentCore Runtime AND used
    // to derive AGENT_BUILD_TAG. Extracting them lets us hash the config so
    // that env-var-only deploys (no image change) still rotate session IDs.
    // Without this, AgentCore sticky-routes existing sessions back to old
    // microVMs whose env snapshot pre-dates the new config.
    const runtimeEnvVars: Record<string, string> = {
      ENVIRONMENT: environment,
      // AgentCore does NOT inject AWS_REGION into the microVM environment, and
      // the AWS SDK requires a region for Bedrock/Secrets Manager/etc. The
      // Python wrapper and every in-image skill compensate with a hardcoded
      // `|| us-east-1` fallback (see agentcore_wrapper.py, workspace_sync.py),
      // but the vendored OpenClaw binary has no such fallback: its native
      // `bedrock` memorySearch provider (openclaw.json agents.defaults.
      // memorySearch) calls bedrock-runtime.<region>.amazonaws.com directly and
      // would fail region resolution without this. Set to this.region so the
      // SDK region matches the region the Bedrock IAM grants are scoped to
      // (arn:aws:bedrock:<region>::foundation-model/*). No-op for existing
      // components (this.region is already their hardcoded default).
      AWS_REGION: this.region,
      AWS_DEFAULT_REGION: this.region,
      WORKSPACE_BUCKET: this.workspaceBucket.bucketName,
      USERS_TABLE: this.usersTable.tableName,
      SIGNALS_TABLE: this.signalsTable.tableName,
      SCHEDULES_TABLE: schedulesTable.tableName,
      TRIAGE_TABLE: this.triageTable.tableName,
      EVENTBRIDGE_SCHEDULE_GROUP: `psd-agent-${environment}`,
      CRON_LAMBDA_ARN: `arn:aws:lambda:${this.region}:${this.account}:function:${cronFunctionName}`,
      TRIAGE_DIGEST_LAMBDA_ARN: `arn:aws:lambda:${this.region}:${this.account}:function:${triageDigestFunctionName}`,
      EVENTBRIDGE_ROLE_ARN: `arn:aws:iam::${this.account}:role/psd-agent-scheduler-invoke-${environment}`,
      GUARDRAIL_ARN: props.guardrailArn,
      DATABASE_RESOURCE_ARN: props.databaseResourceArn,
      DATABASE_SECRET_ARN: props.databaseSecretArn,
      DATABASE_NAME: props.databaseName ?? 'aistudio',
      BEDROCK_API_KEY_SECRET_ARN: this.bedrockApiKeySecret.secretArn,
      SKILL_BUILDER_LAMBDA_ARN: `arn:aws:lambda:${this.region}:${this.account}:function:${skillBuilderFunctionName}`,
      GOOGLE_OAUTH_CLIENT_SECRET_ID: googleOAuthClientSecret.secretName,
      AGENT_INTERNAL_API_KEY_SECRET_ID: agentInternalApiKeySecret.secretName,
      APP_BASE_URL: props.appBaseUrl ?? '',
      PSD_DATA_MCP_URL:
        (this.node.tryGetContext('psdDataMcpUrl') as string | undefined)
        ?? 'https://l3jpggwgsojgql275k6axcboue0syeuq.lambda-url.us-west-2.on.aws/mcp',
      // AI Studio's own MCP endpoint (Issue #1100) — the psd-aistudio skill POSTs
      // JSON-RPC here to read the live capability catalog (describe_capabilities).
      // Derived from APP_BASE_URL so it always tracks the deployed web app;
      // overridable via `-c aistudioMcpUrl=…` for a split/edge deployment.
      AISTUDIO_MCP_URL:
        (this.node.tryGetContext('aistudioMcpUrl') as string | undefined)
        ?? (props.appBaseUrl
          ? `${props.appBaseUrl.replace(/\/+$/, '')}/api/mcp`
          : ''),
      // Secrets Manager id of the scoped sk- content key the psd-atrium skill uses
      // to reach AI Studio's Atrium content REST surface (/api/v1/content, derived
      // from APP_BASE_URL). The skill resolves the key from this secret at call
      // time; populate the secret post-deploy (Issue #1055, see the secret above).
      AISTUDIO_CONTENT_API_KEY_SECRET_ID: atriumContentApiKeySecret.secretName,
      AUTH_COGNITO_USER_POOL_ID: cdk.Fn.importValue(
        `${environment}-CognitoUserPoolId`,
      ),
      AUTH_COGNITO_CLIENT_ID: cdk.Fn.importValue(
        `${environment}-CognitoUserPoolClientId`,
      ),
      AUTH_COGNITO_REGION: this.region,
      BUILD_MARKER: imageDigest
        ? `${imageTag ?? 'no-tag'}@${imageDigest}`
        : (imageTag ?? 'unset'),
    };

    // Fingerprint the env-var config so non-image deploys rotate session IDs.
    // cdk.Fn.importValue tokens stringify to deterministic placeholders, so
    // an upstream value change won't bump the fingerprint — but env-var
    // ADD/REMOVE or literal-value changes (URLs, ARN templates, defaults)
    // will. DJB2 is intentional: this is a non-security fingerprint, and
    // sha256 here trips CodeQL's password-hash detector with a false
    // positive because the dict references (but does not contain) secrets.
    const configFingerprint = (() => {
      const s = JSON.stringify(runtimeEnvVars);
      let h = 5381;
      for (let i = 0; i < s.length; i++) {
        h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
      }
      return h.toString(16).padStart(8, '0');
    })();

    const agentBuildTag = imageDigest
      ? `${imageDigest.replace('sha256:', '').substring(0, 12)}-${configFingerprint}`
      : `${imageTag ?? ''}-${configFingerprint}`;

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
        environmentVariables: runtimeEnvVars,
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
    // 6c. Skill Builder Lambda — per-promotion scan + npm install (#910)
    // =====================================================================
    // Invoked per skill promotion. Downloads draft from S3, scans for secrets/
    // PII/npm vulnerabilities, runs npm install in /tmp, uploads built skill to
    // the destination prefix, and updates the skill registry in Aurora.
    // No network route to microVMs — IAM scoped to skills bucket + Aurora only.

    const skillBuilderRole = ServiceRoleFactory.createLambdaRole(this, 'SkillBuilderLambdaRole', {
      functionName: 'psd-agent-skill-builder',
      environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      s3Buckets: [this.workspaceBucket.bucketName],
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AuroraDataAccess',
            effect: iam.Effect.ALLOW,
            actions: ['rds-data:ExecuteStatement', 'rds-data:BatchExecuteStatement'],
            resources: [props.databaseResourceArn],
          })],
        }),
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

    const skillBuilderLogGroup = new logs.LogGroup(this, 'SkillBuilderLogGroup', {
      logGroupName: `/aws/lambda/${skillBuilderFunctionName}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(skillBuilderLogGroup).add('Environment', environment);
    cdk.Tags.of(skillBuilderLogGroup).add('ManagedBy', 'cdk');

    const skillBuilderLambda = new lambda.Function(this, 'SkillBuilderLambda', {
      deadLetterQueue: agentAsyncDlq, // async-invoke failures → DLQ + alarm (REV-INFRA-128)
      reservedConcurrentExecutions: 1, // serialize async promotions (REV-INFRA-128)
      functionName: skillBuilderFunctionName,
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-skill-builder'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: AGENT_LAMBDA_RUNTIME.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'agent-skill-builder');
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
      memorySize: 2048, // Memory-intensive: npm install + file scanning
      timeout: cdk.Duration.minutes(5),
      architecture: lambda.Architecture.ARM_64,
      role: skillBuilderRole,
      logGroup: skillBuilderLogGroup,
      environment: {
        ENVIRONMENT: environment,
        SKILLS_BUCKET: this.workspaceBucket.bucketName,
        DATABASE_RESOURCE_ARN: props.databaseResourceArn,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
        DATABASE_NAME: props.databaseName ?? 'aistudio',
      },
    });
    cdk.Tags.of(skillBuilderLambda).add('Environment', environment);
    cdk.Tags.of(skillBuilderLambda).add('ManagedBy', 'cdk');

    // SSM parameter for cross-stack reference
    const skillBuilderParam = new ssm.StringParameter(this, 'SkillBuilderLambdaArnParam', {
      parameterName: `/aistudio/${environment}/agent-skill-builder-lambda-arn`,
      stringValue: skillBuilderLambda.functionArn,
      description: 'Skill Builder Lambda function ARN',
    });
    cdk.Tags.of(skillBuilderParam).add('Environment', environment);
    cdk.Tags.of(skillBuilderParam).add('ManagedBy', 'cdk');

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
      logGroupName: `/aws/lambda/${cronFunctionName}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(cronLogGroup).add('Environment', environment);
    cdk.Tags.of(cronLogGroup).add('ManagedBy', 'cdk');

    const cronLambda = new lambda.Function(this, 'CronLambda', {
      deadLetterQueue: agentAsyncDlq, // async-invoke failures → DLQ + alarm (REV-INFRA-128)
      reservedConcurrentExecutions: 1, // prevent overlapping scheduled runs (REV-INFRA-128)
      functionName: cronFunctionName,
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-cron'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: AGENT_LAMBDA_RUNTIME.bundlingImage,
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
      // Single-user invocation: AgentCore response times for a cron fire
      // combine (a) per-deploy cold-start which includes an S3 workspace
      // restore — post-parallelization typically 30–90s for a 10k-file
      // workspace; (b) OpenClaw gateway startup ~5s; (c) model + tool
      // time for the actual scheduled task (research briefs run 2–5 min).
      // Previous 5-minute timeout hit ceiling on every cold fire and
      // 15 min is Lambda's hard ceiling. The morning brief on May 1, 2026
      // hit our 13-min client-side abort while the agent was still
      // streaming heartbeats every 30s — it just hadn't finished yet.
      // Stack: harness deadline 840s (14:00) < AbortSignal 870s (14:30) <
      // Lambda 900s (15:00). Each layer has ~30s headroom over the next
      // so failure modes degrade in order: harness returns partial → abort
      // fires with whatever streamed → Lambda kills as last resort.
      timeout: cdk.Duration.minutes(15),
      architecture: lambda.Architecture.ARM_64,
      role: this.cronLambdaRole,
      logGroup: cronLogGroup,
      environment: {
        ENVIRONMENT: environment,
        USERS_TABLE: this.usersTable.tableName,
        SCHEDULES_TABLE: schedulesTable.tableName,
        GOOGLE_CREDENTIALS_SECRET_ARN: this.googleCredentialsSecret.secretArn,
        DATABASE_RESOURCE_ARN: props.databaseResourceArn,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
        DATABASE_NAME: props.databaseName ?? 'aistudio',
        AWS_ACCOUNT_ID: this.account,
      },
    });

    cdk.Tags.of(cronLambda).add('Environment', environment);
    cdk.Tags.of(cronLambda).add('ManagedBy', 'cdk');

    // Cron Lambda backfills resolved DM space into the schedules row so
    // subsequent invocations skip the Google Chat API scan.
    schedulesTable.grantWriteData(this.cronLambdaRole);

    // Cron Lambda self-heals missing googleIdentity on a schedule by looking
    // the user up via email-index GSI when the event payload omits identity
    // (common for schedules created before the skill populated it).
    // ServiceRoleFactory's DynamoDB grant scopes to the base table ARN but
    // not to GSIs — add the GSI Query permission explicitly.
    this.cronLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'UsersEmailIndexQuery',
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:Query'],
      resources: [`${this.usersTable.tableArn}/index/*`],
    }));

    // Grant Cron Lambda access to Google credentials secret
    this.googleCredentialsSecret.grantRead(this.cronLambdaRole);

    // CloudWatch Logs permissions are granted automatically by CDK when the
    // function is constructed with a managed logGroup prop (see CronLambda
    // below) — no managed policy needed, and scoping to the named group is
    // tighter than AWSLambdaBasicExecutionRole's blanket logs:* on *.

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
    // 7d. Email Triage fanout — dispatcher + worker + FIFO work queue (#1172)
    // =====================================================================
    // Replaces the old single psd-agent-triage-poll Lambda's in-process
    // serial user loop (#996 item 6). Flow:
    //   EventBridge (5-min "poll" / daily "learn") → DISPATCHER Lambda lists
    //   enabled users → one SQS FIFO message per user → WORKER Lambda does the
    //   per-user work (live triage / initial-inbox sweep slice / nightly
    //   learning). FIFO MessageGroupId = userEmail gives per-user
    //   single-flight (the cursor-safety invariant the old
    //   reservedConcurrency=1 provided) while users run in parallel. A DLQ
    //   captures poison users so one bad row can't wedge the queue.
    // See docs/operations/email-triage.md.

    // ---- FIFO work queue + DLQ -------------------------------------------
    const triageWorkDlq = new sqs.Queue(this, 'TriageWorkDLQ', {
      queueName: `psd-agent-triage-work-dlq-${environment}.fifo`,
      fifo: true,
      contentBasedDeduplication: false,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    cdk.Tags.of(triageWorkDlq).add('Environment', environment);
    cdk.Tags.of(triageWorkDlq).add('ManagedBy', 'cdk');

    const triageWorkQueue = new sqs.Queue(this, 'TriageWorkQueue', {
      queueName: `psd-agent-triage-work-${environment}.fifo`,
      fifo: true,
      // Explicit dedup ids are supplied per message (poll = 5-min bucket,
      // learn = date, sweep = page cursor), so content-based dedup is off.
      contentBasedDeduplication: false,
      // High-throughput FIFO: parallelism scales with distinct groups
      // (users), not a single global rate.
      fifoThroughputLimit: sqs.FifoThroughputLimit.PER_MESSAGE_GROUP_ID,
      deduplicationScope: sqs.DeduplicationScope.MESSAGE_GROUP,
      // Visibility >= 6x worker timeout (240s) → 24 min minimum; 30 min here.
      visibilityTimeout: cdk.Duration.minutes(30),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: triageWorkDlq, maxReceiveCount: 3 },
    });
    cdk.Tags.of(triageWorkQueue).add('Environment', environment);
    cdk.Tags.of(triageWorkQueue).add('ManagedBy', 'cdk');

    // ---- Worker role (per-user work: Gmail/Bedrock/AgentCore/Chat) -------
    const triageWorkerRole = ServiceRoleFactory.createLambdaRole(this, 'TriageWorkerLambdaRole', {
      functionName: 'psd-agent-triage-worker',
      environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      // ServiceRoleFactory grants base DynamoDB CRUD on the named tables;
      // the additional resources policy below covers per-user OAuth
      // secrets and Bedrock invocation.
      dynamodbTables: [this.usersTable.tableName, this.triageTable.tableName],
      additionalPolicies: [
        // Per-user OAuth refresh tokens + the shared OAuth client creds.
        // Wildcard on per-user path because we evaluate every opted-in
        // user each tick and don't know the set in advance.
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'WorkspaceTokenRead',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: [
              `arn:aws:secretsmanager:${this.region}:${this.account}:secret:psd-agent-creds/${environment}/user/*`,
              `arn:aws:secretsmanager:${this.region}:${this.account}:secret:psd-agent/${environment}/google-oauth-client-*`,
              this.googleCredentialsSecret.secretArn,
            ],
          })],
        }),
        // Bedrock Nova Micro for the LLM fallback path.
        //
        // Cross-region inference profiles (`us.*` prefix) route the actual
        // model invocation to whichever underlying region has capacity —
        // observed us-west-2 in production (2026-05-22 incident: every
        // call returned 403 because the policy only granted us-east-1).
        // Use wildcard region on the foundation-model resource so the
        // inference profile's downstream invocations are authorised
        // regardless of where AWS routes them. Inference-profile resource
        // stays scoped to this region/account because the profile itself
        // is regional.
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'BedrockNovaMicroInvoke',
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
            resources: [
              `arn:aws:bedrock:*::foundation-model/amazon.nova-micro-v1:0`,
              `arn:aws:bedrock:*::foundation-model/us.amazon.nova-micro-v1:0`,
              `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.amazon.nova-micro-v1:0`,
              // Haiku as the documented fallback if Nova Micro quality is poor —
              // grant now so swap-in doesn't require an IAM change. Same
              // cross-region wildcard for the same reason as nova-micro.
              `arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-20241022-v1:0`,
              `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-3-5-haiku-20241022-v1:0`,
            ],
          })],
        }),
        // AgentCore Runtime invocation — Phase 1.5 @psd/Task gesture
        // hands off to the user's agent (per their MEMORY.md
        // instructions + skills) to create a task in their preferred
        // task system. Scoped to all runtimes in the account/region;
        // the per-runtime ID is set via env var.
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AgentCoreInvokeForTasks',
            effect: iam.Effect.ALLOW,
            actions: [
              'bedrock-agentcore:InvokeAgentRuntime',
              'bedrock-agentcore:InvokeAgentRuntimeForUser',
            ],
            resources: [
              `arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`,
            ],
          })],
        }),
        // SSM Parameter Store — same pattern the cron Lambda uses to
        // resolve the AgentCore Runtime ID at runtime rather than
        // pinning at deploy time.
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'SSMParameterReadForRuntimeId',
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter', 'ssm:GetParameters'],
            resources: [
              `arn:aws:ssm:${this.region}:${this.account}:parameter/aistudio/${environment}/*`,
            ],
          })],
        }),
      ],
    });

    const triageWorkerLogGroup = new logs.LogGroup(this, 'TriageWorkerLogGroup', {
      logGroupName: `/aws/lambda/psd-agent-triage-worker-${environment}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(triageWorkerLogGroup).add('Environment', environment);
    cdk.Tags.of(triageWorkerLogGroup).add('ManagedBy', 'cdk');

    triageWorkerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TriageWorkerLogsCorrectArn',
      effect: iam.Effect.ALLOW,
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/psd-agent-triage-worker-${environment}:*`,
      ],
    }));

    // Read MEMORY.md from each user's S3 workspace prefix.
    triageWorkerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TriageWorkerReadWorkspaceMemory',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${this.workspaceBucket.bucketArn}/*/MEMORY.md`],
    }));

    // Shared code asset — the whole agent-triage-poll dir compiles all
    // *.ts to dist; worker + dispatcher select different handlers off the
    // same bundle, so CDK builds/uploads it once.
    const triageLambdaCode = lambda.Code.fromAsset(
      path.join(__dirname, '..', 'lambdas', 'agent-triage-poll'),
      {
        assetHashType: cdk.AssetHashType.SOURCE,
        bundling: {
          image: AGENT_LAMBDA_RUNTIME.bundlingImage,
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const inputDir = path.join(__dirname, '..', 'lambdas', 'agent-triage-poll');
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
    );

    const triageWorkerLambda = new lambda.Function(this, 'TriageWorkerLambda', {
      functionName: `psd-agent-triage-worker-${environment}`,
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'worker.handler',
      code: triageLambdaCode,
      memorySize: 1024,
      // One SQS message = one user's poll / sweep slice / learning run.
      // 4 min covers a slow sweep page (~50 messages × LLM) with headroom
      // under the queue's 30-min visibility timeout (>= 6× this).
      timeout: cdk.Duration.minutes(4),
      role: triageWorkerRole,
      logGroup: triageWorkerLogGroup,
      environment: {
        ENVIRONMENT: environment,
        TRIAGE_TABLE: this.triageTable.tableName,
        USERS_TABLE: this.usersTable.tableName,
        GOOGLE_CREDENTIALS_SECRET_ARN: this.googleCredentialsSecret.secretArn,
        // Lambda reads <prefix>/MEMORY.md from this bucket to extract the
        // user's task-creation instructions and embed them in the
        // AgentCore prompt verbatim.
        WORKSPACE_BUCKET: this.workspaceBucket.bucketName,
        // Sweep continuations re-enqueue onto this queue (worker → worker).
        TRIAGE_WORK_QUEUE_URL: triageWorkQueue.queueUrl,
        // Override knob — set to 'us.anthropic.claude-3-5-haiku-...' to
        // fall back from Nova Micro without redeploy.
        TRIAGE_LLM_MODEL_ID: 'us.amazon.nova-micro-v1:0',
        // AGENTCORE_RUNTIME_ID intentionally NOT set — resolved from SSM
        // at runtime (same pattern as router/cron Lambdas).
        AWS_ACCOUNT: this.account,
      },
      architecture: lambda.Architecture.ARM_64,
      // Bounded concurrency across users. Per-user single-flight is
      // enforced by the FIFO MessageGroupId (userEmail), so a per-user
      // cursor is never processed by two invocations at once — this cap
      // just limits total parallelism (and downstream Bedrock/Gmail load).
      reservedConcurrentExecutions: 25,
    });
    cdk.Tags.of(triageWorkerLambda).add('Environment', environment);
    cdk.Tags.of(triageWorkerLambda).add('ManagedBy', 'cdk');

    // Worker consumes the FIFO queue (SqsEventSource grants consume) and
    // re-enqueues sweep continuations (needs send).
    triageWorkerLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(triageWorkQueue, {
        // FIFO: no maxBatchingWindow (unsupported). Small batch keeps a
        // poison message's blast radius tiny; partial-batch failures let a
        // good record in the same group succeed.
        batchSize: 5,
        reportBatchItemFailures: true,
      }),
    );
    triageWorkQueue.grantSendMessages(triageWorkerLambda);

    // ---- Dispatcher (fan-out) -------------------------------------------
    // Lists enabled users and enqueues one message per user. Minimal perms:
    // scan the triage table (via ServiceRoleFactory) + send to the queue.
    const triageDispatcherRole = ServiceRoleFactory.createLambdaRole(this, 'TriageDispatcherLambdaRole', {
      functionName: 'psd-agent-triage-dispatcher',
      environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      dynamodbTables: [this.triageTable.tableName],
    });

    const triageDispatcherLogGroup = new logs.LogGroup(this, 'TriageDispatcherLogGroup', {
      logGroupName: `/aws/lambda/psd-agent-triage-dispatcher-${environment}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(triageDispatcherLogGroup).add('Environment', environment);
    cdk.Tags.of(triageDispatcherLogGroup).add('ManagedBy', 'cdk');

    triageDispatcherRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TriageDispatcherLogsCorrectArn',
      effect: iam.Effect.ALLOW,
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/psd-agent-triage-dispatcher-${environment}:*`,
      ],
    }));

    const triageDispatcherLambda = new lambda.Function(this, 'TriageDispatcherLambda', {
      functionName: `psd-agent-triage-dispatcher-${environment}`,
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'dispatcher.handler',
      code: triageLambdaCode,
      memorySize: 512,
      timeout: cdk.Duration.minutes(2),
      role: triageDispatcherRole,
      logGroup: triageDispatcherLogGroup,
      environment: {
        ENVIRONMENT: environment,
        TRIAGE_TABLE: this.triageTable.tableName,
        TRIAGE_WORK_QUEUE_URL: triageWorkQueue.queueUrl,
      },
      architecture: lambda.Architecture.ARM_64,
    });
    cdk.Tags.of(triageDispatcherLambda).add('Environment', environment);
    cdk.Tags.of(triageDispatcherLambda).add('ManagedBy', 'cdk');
    triageWorkQueue.grantSendMessages(triageDispatcherLambda);

    // EventBridge Rule fires the dispatcher every 5 minutes for the live
    // poll (+ sweep kicks). Rule (not Scheduler) is the right primitive for
    // a global fixed cadence — simpler IAM + a constant payload.
    const triagePollRule = new events.Rule(this, 'TriagePollRule', {
      ruleName: `psd-agent-triage-poll-${environment}`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: 'Every-5-minute triage dispatch (poll + sweep kicks)',
    });
    triagePollRule.addTarget(
      new eventsTargets.LambdaFunction(triageDispatcherLambda, {
        event: events.RuleTargetInput.fromObject({ job: 'poll' }),
      }),
    );
    cdk.Tags.of(triagePollRule).add('Environment', environment);
    cdk.Tags.of(triagePollRule).add('ManagedBy', 'cdk');

    // Daily rule fires the dispatcher for the nightly correction-driven
    // learning job. 09:00 UTC ≈ 01:00-02:00 America/Los_Angeles.
    const triageLearnRule = new events.Rule(this, 'TriageLearnRule', {
      ruleName: `psd-agent-triage-learn-${environment}`,
      schedule: events.Schedule.cron({ minute: '0', hour: '9' }),
      description: 'Nightly correction-driven learning dispatch',
    });
    triageLearnRule.addTarget(
      new eventsTargets.LambdaFunction(triageDispatcherLambda, {
        event: events.RuleTargetInput.fromObject({ job: 'learn' }),
      }),
    );
    cdk.Tags.of(triageLearnRule).add('Environment', environment);
    cdk.Tags.of(triageLearnRule).add('ManagedBy', 'cdk');

    // DLQ alarm — a user landing in the DLQ (3 failed receives) needs
    // investigation; their triage is stalled until resolved.
    const triageWorkDlqAlarm = new cloudwatch.Alarm(this, 'TriageWorkDlqAlarm', {
      alarmName: `psd-agent-triage-work-dlq-${environment}`,
      alarmDescription:
        'Email triage work DLQ received messages — a user\'s poll/sweep/learn failed repeatedly',
      metric: triageWorkDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    if (this.agentAlarmTopic) {
      triageWorkDlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.agentAlarmTopic));
    }

    // =====================================================================
    // 7e. Triage Digest Lambda — psd-agent-triage-digest
    // =====================================================================
    // Per-user, invoked by EventBridge Scheduler at the user's configured
    // digestTime. Renders a Chat card summarising last 24h of decisions.
    // No LLM call — templated. Failure does not cascade.
    const triageDigestRole = ServiceRoleFactory.createLambdaRole(this, 'TriageDigestLambdaRole', {
      functionName: 'psd-agent-triage-digest',
      environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      dynamodbTables: [this.triageTable.tableName],
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'GoogleChatCredsRead',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: [this.googleCredentialsSecret.secretArn],
          })],
        }),
      ],
    });

    const triageDigestLogGroup = new logs.LogGroup(this, 'TriageDigestLogGroup', {
      logGroupName: `/aws/lambda/${triageDigestFunctionName}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(triageDigestLogGroup).add('Environment', environment);
    cdk.Tags.of(triageDigestLogGroup).add('ManagedBy', 'cdk');

    triageDigestRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TriageDigestLogsCorrectArn',
      effect: iam.Effect.ALLOW,
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${triageDigestFunctionName}:*`,
      ],
    }));

    const triageDigestLambda = new lambda.Function(this, 'TriageDigestLambda', {
      deadLetterQueue: agentAsyncDlq, // async-invoke failures → DLQ + alarm (REV-INFRA-128)
      functionName: triageDigestFunctionName,
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-triage-digest'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: AGENT_LAMBDA_RUNTIME.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'agent-triage-digest');
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
      memorySize: 512,
      timeout: cdk.Duration.minutes(2),
      role: triageDigestRole,
      logGroup: triageDigestLogGroup,
      environment: {
        ENVIRONMENT: environment,
        TRIAGE_TABLE: this.triageTable.tableName,
        GOOGLE_CREDENTIALS_SECRET_ARN: this.googleCredentialsSecret.secretArn,
      },
      architecture: lambda.Architecture.ARM_64,
    });
    cdk.Tags.of(triageDigestLambda).add('Environment', environment);
    cdk.Tags.of(triageDigestLambda).add('ManagedBy', 'cdk');

    // The digest Lambda is invoked by per-user EventBridge Scheduler
    // entries created by the agent skill. Grant the scheduler invoke
    // role permission to call this Lambda (same role already covers
    // the cron Lambda) so the skill's CreateSchedule calls succeed.
    triageDigestLambda.grantInvoke(schedulerInvokeRole);

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
      // duplicate processing. Router Lambda timeout is 15 min, so 90 min
      // minimum. If the agent genuinely takes longer than the Lambda max
      // and SQS redelivers, the dedup table (psd-agent-message-dedup-{env})
      // still blocks the duplicate from double-invoking AgentCore.
      visibilityTimeout: cdk.Duration.minutes(90),
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
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-router'),
        {
          // Force asset hash from source files so CDK detects code changes.
          // Without this, CDK caches the bundled output hash and may skip
          // Lambda code updates when only TypeScript source changes.
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: AGENT_LAMBDA_RUNTIME.bundlingImage,
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
      // Agent responses can take time: AgentCore microVM cold starts run
      // ~60s on their own; real research-heavy turns stream content for
      // another 3-5 min. 5 min was cutting it razor-thin — observed a
      // 848-char morning-brief reply arrive at the router 19s AFTER a
      // 5-min timeout, with the answer orphaned in the agent's memory
      // and Chat never seeing anything. 15 min is Lambda's hard ceiling
      // and is not user-visible; it only governs how long the Lambda
      // stays alive waiting on AgentCore. The agent still ends when it
      // ends — we just stop killing the request prematurely.
      // SQS visibilityTimeout below MUST stay >= 6x this value.
      timeout: cdk.Duration.minutes(15),
      architecture: lambda.Architecture.ARM_64,
      role: this.routerLambdaRole,
      logGroup: routerLogGroup,
      tracing: config.monitoring.tracingEnabled
        ? lambda.Tracing.ACTIVE
        : lambda.Tracing.DISABLED,
      environment: {
        ENVIRONMENT: environment,
        USERS_TABLE: this.usersTable.tableName,
        SIGNALS_TABLE: this.signalsTable.tableName,
        // Chat-uploaded attachment bytes are delivered to the agent via
        // s3://<workspace-bucket>/<workspacePrefix>/attachments/ (#1138 F1).
        // The role already has PutObject via ServiceRoleFactory s3Buckets.
        WORKSPACE_BUCKET: this.workspaceBucket.bucketName,
        MESSAGE_DEDUP_TABLE: this.messageDedupTable.tableName,
        SESSION_LOCKS_TABLE: this.sessionLocksTable.tableName,
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
        // AGENT_BUILD_TAG — identifier mixed into the AgentCore session ID
        // so deploys invalidate sticky-routed microVMs. Composed of:
        //   - imageDigest (or tag) — rotates on image change
        //   - configHash — rotates on env-var change (computed above)
        // Either kind of change forces the next user message to spawn a
        // fresh microVM with the current env snapshot. Without the
        // configHash component, an env-only deploy leaves users pinned to
        // the OLD microVM until idleRuntimeSessionTimeout (hours for an
        // active user).
        AGENT_BUILD_TAG: agentBuildTag,
      },
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    cdk.Tags.of(this.routerLambda).add('Environment', environment);
    cdk.Tags.of(this.routerLambda).add('ManagedBy', 'cdk');

    // -------------------------------------------------------------------------
    // Async job-runner (issue #1138 — "the 14-minute wall")
    //
    // A multi-step agent turn that hits the router's 14-minute deadline is
    // promoted ONCE to an on-demand Fargate task (promoteToJob in the router).
    // The task runs the SAME compiled agent-router package with a different
    // entrypoint (dist/job-main.js), resumes the same AgentCore session with a
    // 2-hour deadline (AgentCore invocations may run up to 8h — only the
    // Lambda caller was capped at 15 min), and posts the final answer to the
    // originating Chat space. No always-on compute: the cluster is free and
    // tasks exist only while a job runs.
    // -------------------------------------------------------------------------
    const jobCluster = new ecs.Cluster(this, 'JobRunnerCluster', {
      clusterName: `psd-agent-jobs-${environment}`,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    const jobLogGroup = new logs.LogGroup(this, 'JobRunnerLogGroup', {
      logGroupName: `/ecs/psd-agent-job-runner-${environment}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const jobTaskDef = new ecs.FargateTaskDefinition(this, 'JobRunnerTaskDef', {
      family: `psd-agent-job-runner-${environment}`,
      // I/O-bound: the task mostly holds an SSE stream open while the
      // AgentCore microVM does the work. 512/1024 is generous headroom.
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    jobTaskDef.addContainer('job-runner', {
      containerName: 'job-runner',
      image: ecs.ContainerImage.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-router'),
        { file: 'Dockerfile', platform: ecrAssets.Platform.LINUX_ARM64 },
      ),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: jobLogGroup,
        streamPrefix: 'job',
      }),
      environment: {
        ENVIRONMENT: environment,
        // Region for the SDK clients the shared router module constructs.
        AWS_REGION: this.region,
        AWS_ACCOUNT_ID: this.account,
        NODE_ENV: 'production',
        SESSION_LOCKS_TABLE: this.sessionLocksTable.tableName,
        GOOGLE_CREDENTIALS_SECRET_ARN: this.googleCredentialsSecret.secretArn,
        DATABASE_HOST: props.databaseHost,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
        DATABASE_NAME: props.databaseName || 'aistudio',
        // The undici dispatcher must outlive the 2h job deadline: 2h05m.
        AGENTCORE_TIMEOUT_MS_OVERRIDE: String((2 * 60 + 5) * 60 * 1000),
        // JOB_PAYLOAD is injected per-run via RunTask containerOverrides.
      },
    });

    // Task role — mirrors ONLY what job-main.ts touches: AgentCore invoke,
    // the two secrets, the session-locks table, and (via awslogs) the log
    // group on the execution role.
    jobTaskDef.addToTaskRolePolicy(new iam.PolicyStatement({
      sid: 'AgentCoreInvoke',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:InvokeAgentRuntimeForUser'],
      resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`],
    }));
    this.googleCredentialsSecret.grantRead(jobTaskDef.taskRole);
    dbSecret.grantRead(jobTaskDef.taskRole);
    this.sessionLocksTable.grantReadWriteData(jobTaskDef.taskRole);

    const jobRunnerSg = new ec2.SecurityGroup(this, 'JobRunnerSg', {
      vpc,
      // EC2 GroupDescription is ASCII-only — a unicode dash here failed the
      // whole 2026-07-07 deploy (CREATE_FAILED: "Character sets beyond ASCII
      // are not supported"). Keep this string plain ASCII.
      description:
        'psd-agent job-runner Fargate tasks - egress only (Aurora ingress is VPC-CIDR-wide)',
      allowAllOutbound: true,
    });

    // Router promotes turns by launching the task. RunTask needs the task-def
    // ARN and PassRole on both roles the task assumes.
    this.routerLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'JobRunnerLaunch',
      effect: iam.Effect.ALLOW,
      actions: ['ecs:RunTask'],
      resources: [jobTaskDef.taskDefinitionArn],
    }));
    this.routerLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'JobRunnerPassRole',
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [
        jobTaskDef.taskRole.roleArn,
        jobTaskDef.obtainExecutionRole().roleArn,
      ],
      conditions: {
        StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
      },
    }));

    this.routerLambda.addEnvironment('JOB_CLUSTER_ARN', jobCluster.clusterArn);
    this.routerLambda.addEnvironment('JOB_TASK_DEF_ARN', jobTaskDef.taskDefinitionArn);
    this.routerLambda.addEnvironment(
      'JOB_SUBNETS',
      vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
        .subnetIds.join(','),
    );
    this.routerLambda.addEnvironment('JOB_SECURITY_GROUP', jobRunnerSg.securityGroupId);
    this.routerLambda.addEnvironment('JOB_CONTAINER_NAME', 'job-runner');

    cdk.Tags.of(jobCluster).add('Environment', environment);
    cdk.Tags.of(jobCluster).add('ManagedBy', 'cdk');
    cdk.Tags.of(jobLogGroup).add('Environment', environment);
    cdk.Tags.of(jobLogGroup).add('ManagedBy', 'cdk');

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
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-chat-bridge'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: AGENT_LAMBDA_RUNTIME.bundlingImage,
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

    // CloudWatch metric filter — emit a metric every time an
    // AGENT_FAILURE_RECORD line lands in the router Lambda log. Combined with
    // the harness-image structured log line of the same shape, this gives us
    // a single "agent failures per period" metric across all chokepoints.
    const failureMetricNamespace = `PSD/AgentPlatform/${environment}`;
    const failureMetricName = 'AgentFailures';

    // Both router and cron filters intentionally write to the same metric name.
    // They accumulate into one `AgentFailures` metric; per-source breakdown
    // requires querying agent_failures.source in the DB.
    new logs.MetricFilter(this, 'RouterAgentFailureMetric', {
      logGroup: this.routerLambda.logGroup,
      metricNamespace: failureMetricNamespace,
      metricName: failureMetricName,
      filterPattern: logs.FilterPattern.literal('AGENT_FAILURE_RECORD'),
      metricValue: '1',
      defaultValue: 0,
    });

    new logs.MetricFilter(this, 'CronAgentFailureMetric', {
      logGroup: cronLogGroup,
      metricNamespace: failureMetricNamespace,
      metricName: failureMetricName,
      filterPattern: logs.FilterPattern.literal('AGENT_FAILURE_RECORD'),
      metricValue: '1',
      defaultValue: 0,
    });

    // Harness adapter emits the `AgentFailuresHarness` metric directly via
    // boto3 cloudwatch.put_metric_data() from inside the AgentCore container
    // (see infra/agent-image/agent_failures.py). We can't use a CloudWatch
    // MetricFilter the way router/cron do because the AgentCore log group
    // name has a runtime-generated suffix (`psd_agent_<env>-<random>-DEFAULT`)
    // that isn't predictable at CDK synth time, and CFN won't import a
    // non-existent log group.

    // CloudWatch alarm on agent failure rate. Fires when failures exceed 10
    // per 5-minute window — same threshold as the router error alarm so the
    // pager doesn't differentiate the two except by which alarm fired. Tune
    // via the env-specific config if dev noise becomes a problem.
    //
    // Aggregates router/cron (shared `AgentFailures` metric, separate log
    // groups so no double-counting) with the harness metric.
    const period = cdk.Duration.minutes(5);
    const failureRateAlarm = new cloudwatch.Alarm(this, 'AgentFailureRateAlarm', {
      alarmName: `psd-agent-failures-${environment}`,
      alarmDescription:
        `Agent failures >= 10 in 5 min. Triage: https://aistudio.psd401.net/admin/agents (Failures tab)`,
      metric: new cloudwatch.MathExpression({
        expression: 'routerCron + harness',
        usingMetrics: {
          routerCron: new cloudwatch.Metric({
            namespace: failureMetricNamespace,
            metricName: failureMetricName,
            period,
            statistic: 'Sum',
          }),
          harness: new cloudwatch.Metric({
            namespace: failureMetricNamespace,
            metricName: 'AgentFailuresHarness',
            period,
            statistic: 'Sum',
          }),
        },
        period,
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Wire alarm notifications if SNS topic is configured
    if (alarmTopic) {
      const snsAction = new cloudwatchActions.SnsAction(alarmTopic);
      dlqAlarm.addAlarmAction(snsAction);
      errorAlarm.addAlarmAction(snsAction);
      failureRateAlarm.addAlarmAction(snsAction);
    }

    // =====================================================================
    // 9b-2. Degradation alarms + iteration metrics (issue #1161)
    // =====================================================================
    // The #1138 incident's defining failure was that "nothing measured the
    // thing that broke": guardrail screening ran dead for days and SOUL.md was
    // truncated every boot, both invisible because the ERROR/WARN lines just
    // scrolled past for weeks. This block turns each of those silent-degradation
    // classes into a paged metric, extending the AGENT_FAILURE_RECORD filter
    // pattern above.
    //
    // Router / cron / job log groups are importable at synth, so their signals
    // are log MetricFilters keyed off stable marker tokens (GUARDRAIL_DENIAL,
    // AGENT_ERROR_TURN, BACKGROUND_PROMOTION, JOB_RUNNER_FAILED_TURN) plus the
    // PascalCase EmptyAgentResponse errorClass. Container-origin signals
    // (BootTruncationWarn, BuildMarkerBoot/BootOk, AgentNudgeFired) can't use a
    // MetricFilter — the AgentCore log group name has a runtime-generated
    // suffix — so the wrapper/harness emit them directly via put_metric_data
    // (see agent_failures.emit_agent_metric); here we only alarm on them.
    const alarmPeriod = cdk.Duration.minutes(5);
    const iterationAlarms: cloudwatch.Alarm[] = [];

    const routerLog = this.routerLambda.logGroup;
    const sumMetric = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: failureMetricNamespace,
        metricName,
        period: alarmPeriod,
        statistic: 'Sum',
      });

    // -- Router-log metric filters (marker-keyed) --
    new logs.MetricFilter(this, 'GuardrailDenialMetric', {
      logGroup: routerLog,
      metricNamespace: failureMetricNamespace,
      metricName: 'GuardrailDenials',
      filterPattern: logs.FilterPattern.literal('GUARDRAIL_DENIAL'),
      metricValue: '1',
      defaultValue: 0,
    });
    new logs.MetricFilter(this, 'ErrorTurnMetric', {
      logGroup: routerLog,
      metricNamespace: failureMetricNamespace,
      metricName: 'ErrorTurns',
      filterPattern: logs.FilterPattern.literal('AGENT_ERROR_TURN'),
      metricValue: '1',
      defaultValue: 0,
    });
    new logs.MetricFilter(this, 'EmptyAgentResponseMetric', {
      logGroup: routerLog,
      metricNamespace: failureMetricNamespace,
      metricName: 'EmptyAgentResponses',
      filterPattern: logs.FilterPattern.literal('EmptyAgentResponse'),
      metricValue: '1',
      defaultValue: 0,
    });
    // Background-promotion counter — a metric WITHOUT an alarm (the platform
    // compensating for model behavior; its trend feeds Loop-2 tuning, #1161).
    new logs.MetricFilter(this, 'BackgroundPromotionMetric', {
      logGroup: routerLog,
      metricNamespace: failureMetricNamespace,
      metricName: 'BackgroundPromotions',
      filterPattern: logs.FilterPattern.literal('BACKGROUND_PROMOTION'),
      metricValue: '1',
      defaultValue: 0,
    });
    // -- Job-runner (ECS) task-failure filter --
    new logs.MetricFilter(this, 'JobRunnerFailureMetric', {
      logGroup: jobLogGroup,
      metricNamespace: failureMetricNamespace,
      metricName: 'JobRunnerFailures',
      filterPattern: logs.FilterPattern.literal('JOB_RUNNER_FAILED_TURN'),
      metricValue: '1',
      defaultValue: 0,
    });

    // -- Alarms (6). Thresholds mirror the existing operational style
    //    (DLQ >= 1, errors >= 5, failures >= 10). --
    iterationAlarms.push(
      new cloudwatch.Alarm(this, 'GuardrailDenialRateAlarm', {
        alarmName: `psd-agent-guardrail-denials-${environment}`,
        alarmDescription:
          'Guardrail would-have-blocked rate elevated (>= 10 in 5 min). ' +
          'Screening runs detect-only; a spike means either abuse or a broken policy.',
        metric: sumMetric('GuardrailDenials'),
        threshold: 10,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    iterationAlarms.push(
      new cloudwatch.Alarm(this, 'ErrorTurnRateAlarm', {
        alarmName: `psd-agent-error-turns-${environment}`,
        alarmDescription:
          'Agent error-turn rate elevated (>= 10 in 5 min). Triage: ' +
          'https://aistudio.psd401.net/admin/agents (Failures tab).',
        metric: sumMetric('ErrorTurns'),
        threshold: 10,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    iterationAlarms.push(
      new cloudwatch.Alarm(this, 'EmptyAgentResponseAlarm', {
        alarmName: `psd-agent-empty-responses-${environment}`,
        alarmDescription:
          'EmptyAgentResponse rate elevated (>= 5 in 5 min) — users are getting ' +
          'the canned no-response fallback. Often a provider timeout or a prompt regression.',
        metric: sumMetric('EmptyAgentResponses'),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    iterationAlarms.push(
      new cloudwatch.Alarm(this, 'JobRunnerFailureAlarm', {
        alarmName: `psd-agent-job-runner-failures-${environment}`,
        alarmDescription:
          'Background job-runner failed-turn rate elevated (>= 5 in 5 min).',
        metric: sumMetric('JobRunnerFailures'),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    // Boot-truncation: any live image whose bootstrap files exceed the
    // openclaw.json budget (the SOUL.md-truncation-for-weeks signature). The
    // wrapper emits BootTruncationWarn at boot; any occurrence pages.
    iterationAlarms.push(
      new cloudwatch.Alarm(this, 'BootTruncationAlarm', {
        alarmName: `psd-agent-boot-truncation-${environment}`,
        alarmDescription:
          'A live agent image truncated its bootstrap instructions at boot ' +
          '(over openclaw.json budget). The build gate should have caught this — ' +
          'investigate how it shipped.',
        metric: sumMetric('BootTruncationWarn'),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    // Dead-boot detector (the r10 signature): a microVM logged BUILD_MARKER but
    // never reached BOOT_OK. BuildMarkerBoot counts starts, BootOk counts
    // serving-ready boots; a positive difference over the window means a boot
    // died before serving. NOTE: a microVM that boots in the last seconds of a
    // period can transiently show +1 (BUILD_MARKER this period, BootOk the
    // next); it self-clears, and this is a rare "investigate" page, not
    // auto-remediation, so evaluationPeriods stays 1.
    iterationAlarms.push(
      new cloudwatch.Alarm(this, 'DeadBootAlarm', {
        alarmName: `psd-agent-dead-boot-${environment}`,
        alarmDescription:
          'Agent microVM booted (BUILD_MARKER) but never reached BOOT_OK ' +
          '(gateway/provider/model resolution failed) — the r10 dead-boot signature.',
        metric: new cloudwatch.MathExpression({
          expression: 'builds - boots',
          usingMetrics: {
            builds: sumMetric('BuildMarkerBoot'),
            boots: sumMetric('BootOk'),
          },
          period: alarmPeriod,
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    if (alarmTopic) {
      const iterationSnsAction = new cloudwatchActions.SnsAction(alarmTopic);
      for (const a of iterationAlarms) {
        a.addAlarmAction(iterationSnsAction);
      }
    }

    // =====================================================================
    // 9c. Agent Health Daily Lambda (issue #890)
    // =====================================================================
    // Scans S3 workspaces once per day and writes per-user health snapshots
    // into Aurora agent_health_snapshots. Surfaces abandoned agents
    // (no activity in 7+ days) and workspace growth trends in the admin
    // dashboard Health tab.

    const healthLambdaRole = ServiceRoleFactory.createLambdaRole(this, 'AgentHealthDailyRole', {
      functionName: 'psd-agent-health-daily',
      environment,
      region: this.region,
      account: this.account,
      // vpcEnabled: false — VPC access added manually via managed policy below
      // to avoid ServiceRoleFactory's policy validator flagging ENI wildcard resources.
      vpcEnabled: false,
      dynamodbTables: [this.usersTable.tableName],
      s3Buckets: [this.workspaceBucket.bucketName],
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AuroraConnect',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: [props.databaseSecretArn],
          })],
        }),
      ],
    });
    // Aurora via VPC — same managed policy as the Router.
    healthLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );

    const healthLogGroup = new logs.LogGroup(this, 'AgentHealthDailyLogGroup', {
      logGroupName: `/aws/lambda/psd-agent-health-daily-${environment}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const healthLambda = new lambda.Function(this, 'AgentHealthDailyLambda', {
      deadLetterQueue: agentAsyncDlq, // async-invoke failures → DLQ + alarm (REV-INFRA-128)
      reservedConcurrentExecutions: 1, // singleton daily scan (REV-INFRA-128)
      functionName: `psd-agent-health-daily-${environment}`,
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-health-daily'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: AGENT_LAMBDA_RUNTIME.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'agent-health-daily');
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
      memorySize: 512,
      timeout: cdk.Duration.minutes(10),
      architecture: lambda.Architecture.ARM_64,
      role: healthLambdaRole,
      logGroup: healthLogGroup,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        ENVIRONMENT: environment,
        WORKSPACE_BUCKET: this.workspaceBucket.bucketName,
        USERS_TABLE: this.usersTable.tableName,
        DATABASE_HOST: props.databaseHost,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
        DATABASE_NAME: props.databaseName ?? 'aistudio',
        ABANDONED_DAYS: '7',
      },
    });
    cdk.Tags.of(healthLambda).add('Environment', environment);
    cdk.Tags.of(healthLambda).add('ManagedBy', 'cdk');

    new events.Rule(this, 'AgentHealthDailySchedule', {
      description: 'Daily S3 workspace scan to agent_health_snapshots',
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      targets: [new eventsTargets.LambdaFunction(healthLambda)],
    });

    // =====================================================================
    // 9c-bis. Agent Workspace Nonce Cleanup Lambda (#912)
    // =====================================================================
    // Daily DELETE of consent nonces older than RETENTION_DAYS. Without
    // this, psd_agent_workspace_consent_nonces grows unbounded — every
    // consent link burns one row, and abandoned consent attempts (clicked
    // link, never finished OAuth) never get cleaned. The cleanup index
    // makes the range delete efficient.

    const nonceCleanupRole = ServiceRoleFactory.createLambdaRole(this, 'AgentWorkspaceNonceCleanupRole', {
      functionName: 'psd-agent-workspace-nonce-cleanup',
      environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AuroraConnect',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: [props.databaseSecretArn],
          })],
        }),
      ],
    });
    nonceCleanupRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );

    const nonceCleanupLogGroup = new logs.LogGroup(this, 'AgentWorkspaceNonceCleanupLogGroup', {
      logGroupName: `/aws/lambda/psd-agent-workspace-nonce-cleanup-${environment}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const nonceCleanupLambda = new lambda.Function(this, 'AgentWorkspaceNonceCleanupLambda', {
      deadLetterQueue: agentAsyncDlq, // async-invoke failures → DLQ + alarm (REV-INFRA-128)
      reservedConcurrentExecutions: 1, // singleton cleanup sweep (REV-INFRA-128)
      functionName: `psd-agent-workspace-nonce-cleanup-${environment}`,
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-workspace-nonce-cleanup'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: AGENT_LAMBDA_RUNTIME.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'agent-workspace-nonce-cleanup');
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
      timeout: cdk.Duration.minutes(5),
      architecture: lambda.Architecture.ARM_64,
      role: nonceCleanupRole,
      logGroup: nonceCleanupLogGroup,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        ENVIRONMENT: environment,
        DATABASE_HOST: props.databaseHost,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
        DATABASE_NAME: props.databaseName ?? 'aistudio',
        RETENTION_DAYS: '7',
      },
    });
    cdk.Tags.of(nonceCleanupLambda).add('Environment', environment);
    cdk.Tags.of(nonceCleanupLambda).add('ManagedBy', 'cdk');

    new events.Rule(this, 'AgentWorkspaceNonceCleanupSchedule', {
      description: 'Daily DELETE of expired consent nonces (#912)',
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      targets: [new eventsTargets.LambdaFunction(nonceCleanupLambda)],
    });

    // =====================================================================
    // 9d. Agent Pattern Scanner Weekly Lambda (issue #890, Component 3)
    // =====================================================================
    // Scans the DynamoDB signal store and writes cross-building topic
    // convergence patterns into Aurora agent_patterns. Suppressed below
    // 3-signal / 2-building threshold. See pattern-scanner index.ts.

    const patternLambdaRole = ServiceRoleFactory.createLambdaRole(this, 'AgentPatternScannerRole', {
      functionName: 'psd-agent-pattern-scanner',
      environment,
      region: this.region,
      account: this.account,
      // vpcEnabled: false — VPC access added manually via managed policy below
      // to avoid ServiceRoleFactory's policy validator flagging ENI wildcard resources.
      vpcEnabled: false,
      dynamodbTables: [this.signalsTable.tableName],
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AuroraConnect',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: [props.databaseSecretArn],
          })],
        }),
      ],
    });
    patternLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );

    const patternLogGroup = new logs.LogGroup(this, 'AgentPatternScannerLogGroup', {
      logGroupName: `/aws/lambda/psd-agent-pattern-scanner-${environment}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const patternLambda = new lambda.Function(this, 'AgentPatternScannerLambda', {
      deadLetterQueue: agentAsyncDlq, // async-invoke failures → DLQ + alarm (REV-INFRA-128)
      reservedConcurrentExecutions: 1, // singleton weekly scan (REV-INFRA-128)
      functionName: `psd-agent-pattern-scanner-${environment}`,
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-pattern-scanner'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: AGENT_LAMBDA_RUNTIME.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'agent-pattern-scanner');
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
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      architecture: lambda.Architecture.ARM_64,
      role: patternLambdaRole,
      logGroup: patternLogGroup,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        ENVIRONMENT: environment,
        SIGNALS_TABLE: this.signalsTable.tableName,
        DATABASE_HOST: props.databaseHost,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
        DATABASE_NAME: props.databaseName ?? 'aistudio',
        // Privacy suppression thresholds — patterns are only emitted when
        // they meet these floors. Production keeps the privacy floor at
        // 3 signals across 2 buildings; dev drops it to 1/1 so every
        // classified signal surfaces immediately for development.
        MIN_SIGNALS: environment === 'prod' ? '3' : '1',
        MIN_BUILDINGS: environment === 'prod' ? '2' : '1',
        SPIKE_RATIO: '2.0',
        ROLLING_WEEKS: '4',
      },
    });
    cdk.Tags.of(patternLambda).add('Environment', environment);
    cdk.Tags.of(patternLambda).add('ManagedBy', 'cdk');

    // Weekly — Sunday 23:00 UTC (evening after Kaizen scan, per issue #890).
    new events.Rule(this, 'AgentPatternScannerSchedule', {
      description: 'Weekly cross-building topic convergence scan',
      schedule: events.Schedule.cron({ minute: '0', hour: '23', weekDay: 'SUN' }),
      targets: [new eventsTargets.LambdaFunction(patternLambda)],
    });

    // =====================================================================
    // 9b. Telemetry Retention Sweep Lambda — agent-telemetry-prune
    // =====================================================================
    // Deletes rows from agent_message_content + agent_tool_invocations older
    // than RETENTION_DAYS (default 90) to bound the privacy + disk blast
    // radius of the deep-telemetry tables. Aggregated summaries in
    // agent_messages stay forever — only the bulky content/tool-call data
    // is pruned. Daily, 04:00 UTC.
    // vpcEnabled: false — VPC access added manually via managed policy below
    // to avoid ServiceRoleFactory's policy validator flagging the ec2 ENI
    // wildcard resources required for VPC-attached Lambdas. Same workaround
    // as the pattern-scanner Lambda above.
    const pruneLambdaRole = ServiceRoleFactory.createLambdaRole(this, 'AgentTelemetryPruneRole', {
      functionName: 'psd-agent-telemetry-prune',
      environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AuroraConnect',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: [props.databaseSecretArn],
          })],
        }),
      ],
    });
    pruneLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );

    const pruneLogGroup = new logs.LogGroup(this, 'AgentTelemetryPruneLogGroup', {
      logGroupName: `/aws/lambda/psd-agent-telemetry-prune-${environment}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const pruneLambda = new lambda.Function(this, 'AgentTelemetryPruneLambda', {
      deadLetterQueue: agentAsyncDlq, // async-invoke failures → DLQ + alarm (REV-INFRA-128)
      reservedConcurrentExecutions: 1, // singleton prune job (REV-INFRA-128)
      functionName: `psd-agent-telemetry-prune-${environment}`,
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-telemetry-prune'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: AGENT_LAMBDA_RUNTIME.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'agent-telemetry-prune');
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
      memorySize: 512,
      timeout: cdk.Duration.minutes(10),
      architecture: lambda.Architecture.ARM_64,
      role: pruneLambdaRole,
      logGroup: pruneLogGroup,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        ENVIRONMENT: environment,
        DATABASE_HOST: props.databaseHost,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
        DATABASE_NAME: props.databaseName ?? 'aistudio',
        RETENTION_DAYS: '90',
        PRUNE_BATCH: '5000',
      },
    });
    cdk.Tags.of(pruneLambda).add('Environment', environment);
    cdk.Tags.of(pruneLambda).add('ManagedBy', 'cdk');

    const pruneSchedule = new events.Rule(this, 'AgentTelemetryPruneSchedule', {
      description: 'Daily 04:00 UTC - prune agent_message_content + agent_tool_invocations older than 90 days',
      schedule: events.Schedule.cron({ minute: '0', hour: '4' }),
      targets: [new eventsTargets.LambdaFunction(pruneLambda)],
    });
    cdk.Tags.of(pruneSchedule).add('Environment', environment);
    cdk.Tags.of(pruneSchedule).add('ManagedBy', 'cdk');

    // =====================================================================
    // 9c. Bundled-Skill Initializer Lambda + Custom Resource
    // =====================================================================
    // On every deploy, walk infra/agent-image/skills/* SKILL.md frontmatter
    // and UPSERT each skill into psd_agent_skills with scope=shared so the
    // /admin/agents Skills tab shows the real bundled skills, not just
    // greetings-demo. Idempotent: same manifest = no DB churn; image
    // updates bump the s3_key → version increments.

    const bundledSkillsDir = path.join(__dirname, '..', 'agent-image', 'skills');
    interface BundledSkillManifestEntry {
      name: string;
      summary: string;
      description?: string;
      sourceHash: string;
      imageTag: string;
    }
    const bundledSkillsManifest: BundledSkillManifestEntry[] = (() => {
      if (!fs.existsSync(bundledSkillsDir)) return [];
      const out: BundledSkillManifestEntry[] = [];
      for (const entry of fs.readdirSync(bundledSkillsDir)) {
        const skillMdPath = path.join(bundledSkillsDir, entry, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) continue;
        const raw = fs.readFileSync(skillMdPath, 'utf8');
        const fm = raw.match(/^---\n([\s\S]*?)\n---/);
        if (!fm) continue;
        const lines = fm[1].split('\n');
        let name = '';
        let summary = '';
        let description = '';
        for (const line of lines) {
          const m = line.match(/^(name|summary|description):\s*(.*)$/);
          if (!m) continue;
          if (m[1] === 'name') name = m[2].trim();
          else if (m[1] === 'summary') summary = m[2].trim();
          else if (m[1] === 'description') description = m[2].trim();
        }
        if (!name) continue;
        const sourceHash = crypto.createHash('sha256').update(raw).digest('hex');
        out.push({
          name,
          summary: summary || `Bundled skill: ${name}`,
          description,
          sourceHash,
          // Resolved by the lambda at invoke time via env var
          imageTag: 'unknown',
        });
      }
      return out;
    })();

    // vpcEnabled: false — VPC access added manually via managed policy below
    // to avoid ServiceRoleFactory's wildcard-ENI policy validator. Same
    // pattern as the pattern-scanner + telemetry-prune Lambdas.
    const skillInitLambdaRole = ServiceRoleFactory.createLambdaRole(this, 'AgentSkillInitializerRole', {
      functionName: 'psd-agent-skill-initializer',
      environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AuroraConnect',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: [props.databaseSecretArn],
          })],
        }),
      ],
    });
    skillInitLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );

    const skillInitLogGroup = new logs.LogGroup(this, 'AgentSkillInitializerLogGroup', {
      logGroupName: `/aws/lambda/psd-agent-skill-initializer-${environment}`,
      retention: config.monitoring.logRetention,
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const skillInitLambda = new lambda.Function(this, 'AgentSkillInitializerLambda', {
      functionName: `psd-agent-skill-initializer-${environment}`,
      runtime: AGENT_LAMBDA_RUNTIME,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', 'lambdas', 'agent-skill-initializer'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: AGENT_LAMBDA_RUNTIME.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'agent-skill-initializer');
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
      memorySize: 512,
      timeout: cdk.Duration.minutes(2),
      architecture: lambda.Architecture.ARM_64,
      role: skillInitLambdaRole,
      logGroup: skillInitLogGroup,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        ENVIRONMENT: environment,
        DATABASE_HOST: props.databaseHost,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
        DATABASE_NAME: props.databaseName ?? 'aistudio',
      },
    });
    cdk.Tags.of(skillInitLambda).add('Environment', environment);
    cdk.Tags.of(skillInitLambda).add('ManagedBy', 'cdk');

    // Trigger string forces the Custom Resource to re-fire on every deploy
    // so manifest updates land even when the Lambda code hash is unchanged.
    const skillInitTrigger = bundledSkillsManifest
      .map((s) => `${s.name}:${s.sourceHash.slice(0, 8)}`)
      .sort()
      .join(',');

    const agentImageTagContext = this.node.tryGetContext('agentImageTag') ?? 'unset';

    new customResources.AwsCustomResource(this, 'AgentSkillInitializerCR', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: skillInitLambda.functionName,
          Payload: JSON.stringify({
            RequestType: 'Create',
            ResourceProperties: {
              skills: bundledSkillsManifest,
              imageTag: agentImageTagContext,
              trigger: skillInitTrigger,
            },
          }),
        },
        physicalResourceId: customResources.PhysicalResourceId.of('agent-skill-initializer'),
      },
      onUpdate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: skillInitLambda.functionName,
          Payload: JSON.stringify({
            RequestType: 'Update',
            ResourceProperties: {
              skills: bundledSkillsManifest,
              imageTag: agentImageTagContext,
              trigger: skillInitTrigger,
            },
          }),
        },
        physicalResourceId: customResources.PhysicalResourceId.of('agent-skill-initializer'),
      },
      // No onDelete — bundled skills stay in the DB if the stack is destroyed.
      // An admin can clean up via the Skills tab if they want a wipe.
      policy: customResources.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [skillInitLambda.functionArn],
        }),
      ]),
      installLatestAwsSdk: false,
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

    // Bedrock API key secret ARN — consumed by build-and-push.sh (#1161) to run
    // the build-time boot probe + canary turn with canary credentials.
    new cdk.CfnOutput(this, 'BedrockApiKeySecretArn', {
      value: this.bedrockApiKeySecret.secretArn,
      description: 'Bedrock API key secret ARN (build-time canary probe credential)',
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
