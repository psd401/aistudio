import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
// import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as path from 'path';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { ServiceRoleFactory } from './constructs/security';

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

    // Embedding Generator Lambda
    const embeddingGeneratorRole = ServiceRoleFactory.createLambdaRole(this, 'EmbeddingGeneratorRole', {
      functionName: 'embedding-generator',
      environment: props.environment,
      region: this.region,
      account: this.account,
      vpcEnabled: false,
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

    const embeddingGenerator = new lambda.Function(this, 'EmbeddingGenerator', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/embedding-generator')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024, // 1GB
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        DB_CLUSTER_ARN: databaseResourceArn,
        DB_SECRET_ARN: databaseSecretArn,
        DB_NAME: 'aistudio',
        ENVIRONMENT: props.environment,
      },
      layers: [processingLayer],
      role: embeddingGeneratorRole,
    });

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

    // Outputs
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