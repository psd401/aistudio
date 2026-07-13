import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
// import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as path from 'path';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import { execSync } from 'child_process';
import { ServiceRoleFactory } from './constructs/security';
import { VPCProvider, EnvironmentConfig } from './constructs';

export interface ProcessingStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
  // Cross-stack dependencies now retrieved from SSM Parameter Store
  documentsBucketName?: string; // Optional for backward compatibility
  databaseResourceArn?: string; // Optional for backward compatibility
  databaseSecretArn?: string; // Optional for backward compatibility
}

export class ProcessingStack extends cdk.Stack {
  public readonly fileProcessingQueue: sqs.Queue;
  public readonly embeddingQueue: sqs.Queue;
  public readonly jobStatusTable: dynamodb.Table;
  public readonly textractCompletionTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props);

    // Retrieve values from SSM Parameter Store (or use provided props for backward compatibility)
    const documentsBucketName = props.documentsBucketName ||
      ssm.StringParameter.valueForStringParameter(
        this, `/aistudio/${props.environment}/documents-bucket-name`
      );

    const databaseResourceArn = props.databaseResourceArn ||
      ssm.StringParameter.valueForStringParameter(
        this, `/aistudio/${props.environment}/db-cluster-arn`
      );

    const databaseSecretArn = props.databaseSecretArn ||
      ssm.StringParameter.valueForStringParameter(
        this, `/aistudio/${props.environment}/db-secret-arn`
      );

    // Aurora hostname for direct postgres.js connection (embedding-generator)
    const databaseHost = ssm.StringParameter.valueForStringParameter(
      this, `/aistudio/${props.environment}/db-host`
    );

    // VPC + config — required by embedding-generator Lambda (postgres.js needs direct TCP to Aurora)
    const config = EnvironmentConfig.get(props.environment);
    const vpc = VPCProvider.getOrCreate(this, props.environment, config);

    // Import the documents bucket
    const documentsBucket = s3.Bucket.fromBucketName(
      this,
      'DocumentsBucket',
      documentsBucketName
    );

    // DynamoDB table for job status tracking
    this.jobStatusTable = new dynamodb.Table(this, 'JobStatusTable', {
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: props.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // Dead Letter Queue for failed processing jobs
    const dlq = new sqs.Queue(this, 'FileProcessingDLQ', {
      queueName: `aistudio-${props.environment}-file-processing-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    // Main processing queue
    this.fileProcessingQueue = new sqs.Queue(this, 'FileProcessingQueue', {
      queueName: `aistudio-${props.environment}-file-processing-queue`,
      visibilityTimeout: cdk.Duration.minutes(15), // Longer than Lambda timeout
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    // Dead Letter Queue for failed embedding jobs
    const embeddingDlq = new sqs.Queue(this, 'EmbeddingDLQ', {
      queueName: `aistudio-${props.environment}-embedding-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    // Embedding generation queue
    this.embeddingQueue = new sqs.Queue(this, 'EmbeddingQueue', {
      queueName: `aistudio-${props.environment}-embedding-queue`,
      visibilityTimeout: cdk.Duration.minutes(10), // Longer than Lambda timeout
      deadLetterQueue: {
        queue: embeddingDlq,
        maxReceiveCount: 3,
      },
    });

    // SNS Topic for Textract completion notifications
    this.textractCompletionTopic = new sns.Topic(this, 'TextractCompletionTopic', {
      topicName: `aistudio-${props.environment}-textract-completion`,
      displayName: 'Textract Job Completion Notifications',
    });

    // IAM Role for Textract to publish to SNS
    const textractRole = new iam.Role(this, 'TextractServiceRole', {
      assumedBy: new iam.ServicePrincipal('textract.amazonaws.com'),
      roleName: `aistudio-${props.environment}-textract-service-role`,
    });

    // Grant Textract permission to publish to SNS
    this.textractCompletionTopic.grantPublish(textractRole);

    // Lambda Layer for shared dependencies
    const processingLayer = new lambda.LayerVersion(this, 'ProcessingLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../layers/processing')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Shared processing utilities and dependencies',
    });

    // File Processor Lambda
    // PowerTuning Result (2025-10-24): 3008MB → 1024MB (66% reduction)

    // Create secure role using ServiceRoleFactory
    const fileProcessorRole = ServiceRoleFactory.createLambdaRole(this, 'FileProcessorRole', {
      functionName: 'file-processor',
      environment: props.environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      s3Buckets: [documentsBucketName],
      dynamodbTables: [this.jobStatusTable.tableName],
      sqsQueues: [this.embeddingQueue.queueArn],
      secrets: [databaseSecretArn],
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [
            // RDS Data API permissions
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'rds-data:ExecuteStatement',
                'rds-data:BatchExecuteStatement',
                'rds-data:BeginTransaction',
                'rds-data:CommitTransaction',
                'rds-data:RollbackTransaction',
              ],
              resources: [databaseResourceArn],
              conditions: {
                StringEquals: {
                  'aws:ResourceTag/Environment': props.environment,
                  'aws:ResourceTag/ManagedBy': 'cdk',
                },
              },
            }),
            // Textract permissions - requires wildcard (AWS Textract limitation)
            // See: https://docs.aws.amazon.com/textract/latest/dg/security_iam_service-with-iam.html
            // Note: Textract doesn't support resource-level permissions or service-specific conditions
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'textract:StartDocumentTextDetection',
                'textract:StartDocumentAnalysis',
                'textract:GetDocumentTextDetection',
                'textract:GetDocumentAnalysis',
              ],
              resources: ['*'],  // Required: Textract doesn't support resource-level permissions
            }),
            // Pass Textract service role
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['iam:PassRole'],
              resources: [textractRole.roleArn],
            }),
          ],
        }),
      ],
    });

    const fileProcessor = new lambda.Function(this, 'FileProcessor', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/file-processor')),
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024, // Optimized via PowerTuning from 3GB
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        DOCUMENTS_BUCKET_NAME: documentsBucket.bucketName,
        JOB_STATUS_TABLE: this.jobStatusTable.tableName,
        DATABASE_RESOURCE_ARN: databaseResourceArn,
        DATABASE_SECRET_ARN: databaseSecretArn,
        DATABASE_NAME: 'aistudio',
        ENVIRONMENT: props.environment,
        EMBEDDING_QUEUE_URL: this.embeddingQueue.queueUrl,
        TEXTRACT_SNS_TOPIC_ARN: this.textractCompletionTopic.topicArn,
        TEXTRACT_ROLE_ARN: textractRole.roleArn,
      },
      layers: [processingLayer],
      role: fileProcessorRole,  // Use secure role from ServiceRoleFactory
    });

    // URL Processor Lambda
    const urlProcessorRole = ServiceRoleFactory.createLambdaRole(this, 'URLProcessorRole', {
      functionName: 'url-processor',
      environment: props.environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      dynamodbTables: [this.jobStatusTable.tableName],
      secrets: [databaseSecretArn],
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [
            // RDS Data API permissions
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'rds-data:ExecuteStatement',
                'rds-data:BatchExecuteStatement',
                'rds-data:BeginTransaction',
                'rds-data:CommitTransaction',
                'rds-data:RollbackTransaction',
              ],
              resources: [databaseResourceArn],
              conditions: {
                StringEquals: {
                  'aws:ResourceTag/Environment': props.environment,
                  'aws:ResourceTag/ManagedBy': 'cdk',
                },
              },
            }),
          ],
        }),
      ],
    });

    const urlProcessor = new lambda.Function(this, 'URLProcessor', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/url-processor')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024, // 1GB
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        JOB_STATUS_TABLE: this.jobStatusTable.tableName,
        DATABASE_RESOURCE_ARN: databaseResourceArn,
        DATABASE_SECRET_ARN: databaseSecretArn,
        DATABASE_NAME: 'aistudio',
        ENVIRONMENT: props.environment,
      },
      layers: [processingLayer],
      role: urlProcessorRole,
    });

    // Embedding Generator Lambda — uses postgres.js + Drizzle (Issue #578), must be in VPC
    const embeddingGeneratorRole = ServiceRoleFactory.createLambdaRole(this, 'EmbeddingGeneratorRole', {
      functionName: 'embedding-generator',
      environment: props.environment,
      region: this.region,
      account: this.account,
      // vpcEnabled: false — VPC access added manually via managed policy below
      // to avoid ServiceRoleFactory's policy validator flagging ENI wildcard resources.
      vpcEnabled: false,
      sqsQueues: [this.embeddingQueue.queueArn],
      // secrets[] uses tag-conditional access which won't match the DatabaseStack secret.
      // Add an explicit statement without tag conditions instead (same as AgentHealthDailyRole).
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            sid: 'AuroraSecretAccess',
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: [databaseSecretArn],
          })],
        }),
      ],
    });
    // Aurora via VPC — same managed policy pattern as AgentHealthDailyRole, RouterLambda, etc.
    embeddingGeneratorRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );

    const embeddingGeneratorSg = new ec2.SecurityGroup(this, 'EmbeddingGeneratorSg', {
      vpc,
      description: 'Security group for embedding-generator Lambda (postgres.js to Aurora)',
      allowAllOutbound: true,
    });

    const embeddingGenerator = new lambda.Function(this, 'EmbeddingGenerator', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../lambdas/embedding-generator'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: lambda.Runtime.NODEJS_20_X.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'embedding-generator');
                  execSync('bun install && bunx tsc', { cwd: inputDir, stdio: 'inherit' });
                  execSync(`cp -r dist/* ${outputDir}/`, { cwd: inputDir, stdio: 'inherit' });
                  execSync(`cp package.json ${outputDir}/`, { cwd: inputDir, stdio: 'inherit' });
                  execSync('bun install --production', { cwd: outputDir, stdio: 'inherit' });
                  return true;
                } catch (e) {
                  process.stderr.write(`Local bundling failed, falling back to Docker: ${e}\n`);
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
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024, // 1GB
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [embeddingGeneratorSg],
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        DATABASE_HOST: databaseHost,
        DATABASE_SECRET_ARN: databaseSecretArn,
        DATABASE_NAME: 'aistudio',
        DATABASE_PORT: '5432',
        ENVIRONMENT: props.environment,
      },
      layers: [processingLayer],
      role: embeddingGeneratorRole,
    });
    cdk.Tags.of(embeddingGenerator).add('Environment', props.environment);
    cdk.Tags.of(embeddingGenerator).add('ManagedBy', 'cdk');

    // Textract Processor Lambda
    const textractProcessorRole = ServiceRoleFactory.createLambdaRole(this, 'TextractProcessorRole', {
      functionName: 'textract-processor',
      environment: props.environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
      sqsQueues: [this.embeddingQueue.queueArn],
      secrets: [databaseSecretArn],
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [
            // RDS Data API permissions
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'rds-data:ExecuteStatement',
                'rds-data:BatchExecuteStatement',
                'rds-data:BeginTransaction',
                'rds-data:CommitTransaction',
                'rds-data:RollbackTransaction',
              ],
              resources: [databaseResourceArn],
              conditions: {
                StringEquals: {
                  'aws:ResourceTag/Environment': props.environment,
                  'aws:ResourceTag/ManagedBy': 'cdk',
                },
              },
            }),
            // Textract permissions - requires wildcard (AWS Textract limitation)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'textract:StartDocumentTextDetection',
                'textract:StartDocumentAnalysis',
                'textract:GetDocumentTextDetection',
                'textract:GetDocumentAnalysis',
              ],
              resources: ['*'],  // Required: Textract doesn't support resource-level permissions
            }),
          ],
        }),
      ],
    });

    const textractProcessor = new lambda.Function(this, 'TextractProcessor', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/textract-processor')),
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024, // 1GB
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        DATABASE_RESOURCE_ARN: databaseResourceArn,
        DATABASE_SECRET_ARN: databaseSecretArn,
        DATABASE_NAME: 'aistudio',
        EMBEDDING_QUEUE_URL: this.embeddingQueue.queueUrl,
        ENVIRONMENT: props.environment,
      },
      layers: [processingLayer],
      role: textractProcessorRole,
    });

    // Subscribe Textract processor to SNS topic
    this.textractCompletionTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(textractProcessor)
    );

    // All Lambda functions now use ServiceRoleFactory with secure roles
    // Permissions are defined in the role creation above
    // No manual permission grants needed!

    // SQS event source for file processor
    fileProcessor.addEventSource(new lambdaEventSources.SqsEventSource(this.fileProcessingQueue, {
      batchSize: 1, // Process one file at a time
      maxBatchingWindow: cdk.Duration.seconds(5),
    }));

    // SQS event source for embedding generator
    embeddingGenerator.addEventSource(new lambdaEventSources.SqsEventSource(this.embeddingQueue, {
      batchSize: 1, // Process one item at a time to avoid rate limits
      maxBatchingWindow: cdk.Duration.seconds(5),
    }));

    // =====================================================================
    // Group Sync Lambda (Epic #1202, Phase 0 / #1203)
    // =====================================================================
    // Hourly Google Directory sync: resolves the admin selection (picks ∪ prefix
    // rules), fetches each group's transitive membership, and full-replaces
    // group_members per group with last-known-good fail-safety. Reads all config
    // (SA secret ARN, customer id, optional DWD subject, enabled flag) from the
    // settings table at runtime — so no redeploy is needed to (re)configure it.
    // In VPC (PRIVATE_WITH_EGRESS) for postgres.js → Aurora AND NAT egress to the
    // Google Directory / Cloud Identity APIs. Same role/VPC pattern as
    // embedding-generator and AgentHealthDaily.
    //
    // The SA JSON key secret is admin-chosen at runtime, so the read grant is
    // scoped by NAME PATTERN (aistudio-<env>-google-directory-*) rather than a
    // single ARN — least-privilege to the directory-sync secret family only.
    const groupSyncSaSecretArnPattern =
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:aistudio-${props.environment}-google-directory-*`;

    const groupSyncRole = ServiceRoleFactory.createLambdaRole(this, 'GroupSyncRole', {
      functionName: 'psd-group-sync',
      environment: props.environment,
      region: this.region,
      account: this.account,
      // vpcEnabled: false — VPC access added manually via the managed policy below
      // to avoid ServiceRoleFactory's policy validator flagging ENI wildcard resources.
      vpcEnabled: false,
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [
            // Aurora credentials (DatabaseStack secret) — no tag condition (same
            // as EmbeddingGeneratorRole/AgentHealthDailyRole).
            new iam.PolicyStatement({
              sid: 'AuroraSecretAccess',
              effect: iam.Effect.ALLOW,
              actions: ['secretsmanager:GetSecretValue'],
              resources: [databaseSecretArn],
            }),
            // Google service-account JSON key — scoped to the directory-sync
            // secret name family.
            new iam.PolicyStatement({
              sid: 'GoogleDirectorySaSecretAccess',
              effect: iam.Effect.ALLOW,
              actions: ['secretsmanager:GetSecretValue'],
              resources: [groupSyncSaSecretArnPattern],
            }),
            // Sync-run metrics (namespace-scoped).
            new iam.PolicyStatement({
              sid: 'GroupSyncMetrics',
              effect: iam.Effect.ALLOW,
              actions: ['cloudwatch:PutMetricData'],
              resources: ['*'],
              conditions: {
                StringEquals: { 'cloudwatch:namespace': 'AIStudio/GroupSync' },
              },
            }),
          ],
        }),
      ],
    });
    groupSyncRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );

    const groupSyncSg = new ec2.SecurityGroup(this, 'GroupSyncSg', {
      vpc,
      description: 'Security group for group-sync Lambda (Aurora + Google Directory egress)',
      allowAllOutbound: true,
    });

    const groupSyncLambda = new lambda.Function(this, 'GroupSync', {
      functionName: `psd-group-sync-${props.environment}`,
      // Singleton: a manual "Sync now" must not race the hourly schedule into
      // two concurrent full-replaces of the same group (mirrors AgentHealthDaily
      // / nonce-cleanup). A throttled scheduled invoke retries on its own.
      reservedConcurrentExecutions: 1,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../lambdas/group-sync'),
        {
          assetHashType: cdk.AssetHashType.SOURCE,
          bundling: {
            image: lambda.Runtime.NODEJS_20_X.bundlingImage,
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  const inputDir = path.join(__dirname, '..', 'lambdas', 'group-sync');
                  execSync('bun install && bunx tsc', { cwd: inputDir, stdio: 'inherit' });
                  execSync(`cp -r dist/* ${outputDir}/`, { cwd: inputDir, stdio: 'inherit' });
                  execSync(`cp package.json ${outputDir}/`, { cwd: inputDir, stdio: 'inherit' });
                  execSync('bun install --production', { cwd: outputDir, stdio: 'inherit' });
                  return true;
                } catch (e) {
                  process.stderr.write(`Local bundling failed, falling back to Docker: ${e}\n`);
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
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      architecture: lambda.Architecture.ARM_64,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [groupSyncSg],
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        DATABASE_HOST: databaseHost,
        DATABASE_SECRET_ARN: databaseSecretArn,
        DATABASE_NAME: 'aistudio',
        DATABASE_PORT: '5432',
        ENVIRONMENT: props.environment,
      },
      role: groupSyncRole,
    });
    cdk.Tags.of(groupSyncLambda).add('Environment', props.environment);
    cdk.Tags.of(groupSyncLambda).add('ManagedBy', 'cdk');

    // Hourly schedule. The same function is async-invoked by the admin
    // "Sync now" action (see lib/groups/trigger.ts).
    new events.Rule(this, 'GroupSyncHourlySchedule', {
      description: 'Hourly Google Directory group membership sync (#1203)',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new eventsTargets.LambdaFunction(groupSyncLambda)],
    });

    // Outputs
    new cdk.CfnOutput(this, 'GroupSyncFunctionName', {
      value: groupSyncLambda.functionName,
      description: 'Name of the Google Directory group-sync Lambda function',
      exportName: `${props.environment}-GroupSyncFunctionName`,
    });

    new cdk.CfnOutput(this, 'FileProcessingQueueUrl', {
      value: this.fileProcessingQueue.queueUrl,
      description: 'URL of the file processing queue',
      exportName: `${props.environment}-FileProcessingQueueUrl`,
    });

    new cdk.CfnOutput(this, 'FileProcessingQueueArn', {
      value: this.fileProcessingQueue.queueArn,
      description: 'ARN of the file processing queue',
      exportName: `${props.environment}-FileProcessingQueueArn`,
    });

    new cdk.CfnOutput(this, 'JobStatusTableName', {
      value: this.jobStatusTable.tableName,
      description: 'Name of the job status DynamoDB table',
      exportName: `${props.environment}-JobStatusTableName`,
    });

    new cdk.CfnOutput(this, 'FileProcessorFunctionName', {
      value: fileProcessor.functionName,
      description: 'Name of the file processor Lambda function',
      exportName: `${props.environment}-FileProcessorFunctionName`,
    });

    new cdk.CfnOutput(this, 'URLProcessorFunctionName', {
      value: urlProcessor.functionName,
      description: 'Name of the URL processor Lambda function',
      exportName: `${props.environment}-URLProcessorFunctionName`,
    });

    new cdk.CfnOutput(this, 'EmbeddingQueueUrl', {
      value: this.embeddingQueue.queueUrl,
      description: 'URL of the embedding generation queue',
      exportName: `${props.environment}-EmbeddingQueueUrl`,
    });

    new cdk.CfnOutput(this, 'EmbeddingQueueArn', {
      value: this.embeddingQueue.queueArn,
      description: 'ARN of the embedding generation queue',
      exportName: `${props.environment}-EmbeddingQueueArn`,
    });

    new cdk.CfnOutput(this, 'EmbeddingGeneratorFunctionName', {
      value: embeddingGenerator.functionName,
      description: 'Name of the embedding generator Lambda function',
      exportName: `${props.environment}-EmbeddingGeneratorFunctionName`,
    });

    new cdk.CfnOutput(this, 'TextractCompletionTopicArn', {
      value: this.textractCompletionTopic.topicArn,
      description: 'ARN of the Textract completion SNS topic',
      exportName: `${props.environment}-TextractCompletionTopicArn`,
    });

    new cdk.CfnOutput(this, 'TextractServiceRoleArn', {
      value: textractRole.roleArn,
      description: 'ARN of the Textract service role',
      exportName: `${props.environment}-TextractServiceRoleArn`,
    });

    new cdk.CfnOutput(this, 'TextractProcessorFunctionName', {
      value: textractProcessor.functionName,
      description: 'Name of the Textract processor Lambda function',
      exportName: `${props.environment}-TextractProcessorFunctionName`,
    });
  }
}