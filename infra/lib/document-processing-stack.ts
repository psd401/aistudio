import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';

export interface DocumentProcessingStackProps extends cdk.StackProps {
  environment: string;
  rdsClusterArn?: string;
  rdsSecretArn?: string;
  documentsBucketName: string;
}

export class DocumentProcessingStack extends cdk.Stack {
  public readonly documentJobsTable: dynamodb.Table;
  public readonly documentsBucket: s3.IBucket;
  public readonly processingQueue: sqs.Queue;
  public readonly processingDLQ: sqs.Queue;
  public readonly highMemoryQueue: sqs.Queue;
  public readonly standardProcessor: lambda.Function;
  public readonly highMemoryProcessor: lambda.Function;

  constructor(scope: Construct, id: string, props: DocumentProcessingStackProps) {
    super(scope, id, props);

    const { environment, documentsBucketName } = props;
    const retireLegacyContent =
      this.node.tryGetContext('retireLegacyContent') === true ||
      this.node.tryGetContext('retireLegacyContent') === 'true';

    // DynamoDB table for job tracking with fast polling
    this.documentJobsTable = new dynamodb.Table(this, 'DocumentJobs', {
      tableName: `AIStudio-DocumentJobs-${environment}`,
      partitionKey: {
        name: 'jobId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      timeToLiveAttribute: 'ttl',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // GSI for querying by user ID
    this.documentJobsTable.addGlobalSecondaryIndex({
      indexName: 'UserIdIndex',
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
    });

    // GSI for querying by status
    this.documentJobsTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
    });

    // Import existing documents bucket from StorageStack
    this.documentsBucket = s3.Bucket.fromBucketName(
      this,
      'ExistingDocumentsBucket',
      documentsBucketName
    );

    // Dead Letter Queue for failed processing jobs
    this.processingDLQ = new sqs.Queue(this, 'ProcessingDLQ', {
      queueName: `AIStudio-DocumentProcessing-DLQ-${environment}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED, // SSE at rest — REV-INFRA-165
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Standard processing queue for files under 50MB
    this.processingQueue = new sqs.Queue(this, 'ProcessingQueue', {
      queueName: `AIStudio-DocumentProcessing-${environment}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED, // SSE at rest — REV-INFRA-165
      visibilityTimeout: cdk.Duration.minutes(15), // 15 minutes for processing
      receiveMessageWaitTime: cdk.Duration.seconds(20), // Long polling
      deadLetterQueue: {
        queue: this.processingDLQ,
        maxReceiveCount: 3,
      },
      removalPolicy: environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // High-memory queue for large files (50MB+)
    this.highMemoryQueue = new sqs.Queue(this, 'HighMemoryQueue', {
      queueName: `AIStudio-DocumentProcessing-HighMemory-${environment}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED, // SSE at rest — REV-INFRA-165
      visibilityTimeout: cdk.Duration.minutes(15), // Match Lambda timeout
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      deadLetterQueue: {
        queue: this.processingDLQ,
        maxReceiveCount: 2, // Fewer retries for expensive operations
      },
      removalPolicy: environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const processorRole = this.createProcessorRole(props);

    const processors = this.createProcessors(props, processorRole);
    this.standardProcessor = processors.standard;
    this.highMemoryProcessor = processors.highMemory;

    // Event sources for Lambda triggers
    this.standardProcessor.addEventSource(
      new eventsources.SqsEventSource(this.processingQueue, {
        batchSize: 5, // Process up to 5 documents at once
        maxConcurrency: 10, // Limit concurrent executions
        reportBatchItemFailures: true,
      })
    );

    this.highMemoryProcessor.addEventSource(
      new eventsources.SqsEventSource(this.highMemoryQueue, {
        batchSize: 1, // Process one large file at a time
        maxConcurrency: 2, // Limit concurrent high-memory processing
        reportBatchItemFailures: true,
      })
    );

    // Note: S3 event notifications removed - Documents v2 uses direct job processing
    // via sendToProcessingQueue() instead of S3-triggered processing

    // CloudWatch Dashboard removed - metrics now exported to consolidated dashboards via MonitoringStack

    // Stack outputs
    const legacyOutputs = [
      new cdk.CfnOutput(this, 'DocumentJobsTableName', {
        value: this.documentJobsTable.tableName,
        description: 'DynamoDB table for document job tracking',
        exportName: `${props.environment}-DocumentJobsTableName`,
      }),
    ];

    // Note: DocumentsBucketName is already exported by StorageStack, don't duplicate it here

    legacyOutputs.push(
      new cdk.CfnOutput(this, 'ProcessingQueueUrl', {
        value: this.processingQueue.queueUrl,
        description: 'SQS queue for standard document processing',
        exportName: `${props.environment}-ProcessingQueueUrl`,
      })
    );

    legacyOutputs.push(
      new cdk.CfnOutput(this, 'HighMemoryQueueUrl', {
        value: this.highMemoryQueue.queueUrl,
        description: 'SQS queue for high-memory document processing',
        exportName: `${props.environment}-HighMemoryQueueUrl`,
      })
    );

    this.retireLegacyResourcesIfRequested(
      retireLegacyContent,
      processorRole,
      legacyOutputs
    );
  }

  private retireLegacyResourcesIfRequested(
    retireLegacyContent: boolean,
    processorRole: iam.Role,
    legacyOutputs: cdk.CfnOutput[]
  ): void {
    if (!retireLegacyContent) return;

    // Keep the stack in the CDK assembly so `cdk deploy --all` can actually
    // remove its resources. Omitting an already-deployed stack from an
    // assembly leaves that CloudFormation stack running indefinitely.
    const retainLegacyCondition = new cdk.CfnCondition(
      this,
      'RetainLegacyDocumentProcessing',
      {
        expression: cdk.Fn.conditionEquals('retired', 'retained'),
      }
    );
    this.documentJobsTable.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    this.processingDLQ.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    this.processingQueue.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    this.highMemoryQueue.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const legacyRoots: Construct[] = [
      this.documentJobsTable,
      this.processingDLQ,
      this.processingQueue,
      this.highMemoryQueue,
      processorRole,
      this.standardProcessor,
      this.highMemoryProcessor,
      ...legacyOutputs,
    ];
    const conditioned = new Set<cdk.CfnElement>();
    for (const root of legacyRoots) {
      this.conditionLegacyConstructs(
        root,
        conditioned,
        retainLegacyCondition
      );
    }
  }

  private conditionLegacyConstructs(
    root: Construct,
    conditioned: Set<cdk.CfnElement>,
    retainLegacyCondition: cdk.CfnCondition
  ): void {
    for (const construct of root.node.findAll()) {
      const element = construct as cdk.CfnElement;
      if (element instanceof cdk.CfnResource && !conditioned.has(element)) {
        element.cfnOptions.condition = retainLegacyCondition;
        conditioned.add(element);
      } else if (
        element instanceof cdk.CfnOutput &&
        !conditioned.has(element)
      ) {
        element.condition = retainLegacyCondition;
        conditioned.add(element);
      }
    }
  }

  private createProcessorRole(props: DocumentProcessingStackProps): iam.Role {
    // IAM role for Lambda processors
    return new iam.Role(this, 'ProcessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          'ProcessorLambdaBasicExecPolicy',
          'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
        ),
      ],
      inlinePolicies: {
        ProcessorPolicy: new iam.PolicyDocument({
          statements: [
            // S3 permissions
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                's3:GetObject',
                's3:PutObject',
                's3:DeleteObject',
                's3:GetObjectVersion',
              ],
              resources: [`${this.documentsBucket.bucketArn}/*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:ListBucket'],
              resources: [this.documentsBucket.bucketArn],
            }),
            // DynamoDB permissions
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'dynamodb:PutItem',
                'dynamodb:GetItem',
                'dynamodb:UpdateItem',
                'dynamodb:DeleteItem',
                'dynamodb:Query',
                'dynamodb:Scan',
              ],
              resources: [
                this.documentJobsTable.tableArn,
                `${this.documentJobsTable.tableArn}/index/*`,
              ],
            }),
            // SQS permissions for cross-queue messaging
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'sqs:SendMessage',
                'sqs:ReceiveMessage',
                'sqs:DeleteMessage',
                'sqs:GetQueueAttributes',
              ],
              resources: [
                this.processingQueue.queueArn,
                this.highMemoryQueue.queueArn,
                this.processingDLQ.queueArn,
              ],
            }),
            // Textract permissions for OCR
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'textract:DetectDocumentText',    // For sync text detection
                'textract:AnalyzeDocument',       // For sync document analysis
              ],
              resources: ['*'],
            }),
            // RDS Data API permissions (if provided)
            ...(props.rdsClusterArn ? [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  'rds-data:ExecuteStatement',
                  'rds-data:BatchExecuteStatement',
                  'rds-data:BeginTransaction',
                  'rds-data:CommitTransaction',
                  'rds-data:RollbackTransaction',
                ],
                resources: [props.rdsClusterArn],
              }),
            ] : []),
            // Secrets Manager permissions (if provided)
            ...(props.rdsSecretArn ? [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  'secretsmanager:GetSecretValue',
                  'secretsmanager:DescribeSecret',
                ],
                resources: [props.rdsSecretArn],
              }),
            ] : []),
          ],
        }),
      },
    });
  }

  private createProcessors(
    props: DocumentProcessingStackProps,
    processorRole: iam.Role
  ): { standard: lambda.Function; highMemory: lambda.Function } {
    const { environment } = props;

    // Standard Lambda processor (3GB memory, 15 min timeout)
    const standardProcessor = new lambda.Function(this, 'StandardProcessor', {
      functionName: `AIStudio-DocumentProcessor-Standard-${environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'dist/index.handler',
      code: lambda.Code.fromAsset('lambdas/document-processor-v2'),
      memorySize: 3008, // 3GB for standard processing
      timeout: cdk.Duration.minutes(15),
      role: processorRole,
      environment: {
        DOCUMENTS_BUCKET_NAME: this.documentsBucket.bucketName,
        DOCUMENT_JOBS_TABLE: this.documentJobsTable.tableName,
        HIGH_MEMORY_QUEUE_URL: this.highMemoryQueue.queueUrl,
        DLQ_URL: this.processingDLQ.queueUrl,
        ...(props.rdsClusterArn && { DATABASE_RESOURCE_ARN: props.rdsClusterArn }),
        ...(props.rdsSecretArn && { DATABASE_SECRET_ARN: props.rdsSecretArn }),
        DATABASE_NAME: 'aistudio',
      },
      deadLetterQueue: this.processingDLQ,
      retryAttempts: 2,
    });

    // High-memory Lambda processor
    // PowerTuning Result (2025-10-24): 10240MB → 1536MB (85% reduction)
    const highMemoryProcessor = new lambda.Function(this, 'HighMemoryProcessor', {
      functionName: `AIStudio-DocumentProcessor-HighMemory-${environment}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'dist/index.handler',
      code: lambda.Code.fromAsset('lambdas/document-processor-v2'),
      memorySize: 1536, // Optimized via PowerTuning from 10GB
      timeout: cdk.Duration.minutes(15), // Lambda max timeout is 15 minutes
      role: processorRole,
      environment: {
        DOCUMENTS_BUCKET_NAME: this.documentsBucket.bucketName,
        DOCUMENT_JOBS_TABLE: this.documentJobsTable.tableName,
        DLQ_URL: this.processingDLQ.queueUrl,
        PROCESSOR_TYPE: 'HIGH_MEMORY',
        ...(props.rdsClusterArn && { DATABASE_RESOURCE_ARN: props.rdsClusterArn }),
        ...(props.rdsSecretArn && { DATABASE_SECRET_ARN: props.rdsSecretArn }),
        DATABASE_NAME: 'aistudio',
      },
      deadLetterQueue: this.processingDLQ,
      retryAttempts: 1, // Fewer retries for expensive operations
    });

    return { standard: standardProcessor, highMemory: highMemoryProcessor };
  }
}
