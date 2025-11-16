import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { DataClassification } from './constructs/storage/data-classification';
import { StorageLensConfig } from './constructs/storage/storage-lens';
import { CostMonitor } from './constructs/storage/cost-monitor';

export interface StorageStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
  /** Email address for cost alerts (optional) */
  alertEmail?: string;
  /** Enable CloudFront CDN (default: false) */
  enableCdn?: boolean;
  /** Enable cross-region replication (default: false for dev, true for prod) */
  enableReplication?: boolean;
  /** Replication regions (default: us-east-1) */
  replicationRegions?: string[];
}

export class StorageStack extends cdk.Stack {
  public readonly documentsBucketName: string;
  public readonly documentsBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    // Create bucket for Storage Lens reports
    const reportsBucket = new s3.Bucket(this, 'ReportsBucket', {
      bucketName: `aistudio-storage-reports-${props.environment}-${cdk.Aws.ACCOUNT_ID}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: props.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: props.environment !== 'prod',
      lifecycleRules: [
        {
          id: 'ExpireOldReports',
          enabled: true,
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    // Create S3 bucket for document storage
    // NOTE: Using direct s3.Bucket instead of OptimizedBucket to preserve CloudFormation logical ID
    // This prevents bucket replacement. OptimizedBucket will be re-introduced in a future PR with proper migration.
    // IMPORTANT: bucketName is omitted to match the currently deployed bucket (auto-generated name)
    const documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: props.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: props.environment !== 'prod',
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: [
            props.environment === 'prod'
              ? 'https://aistudio.psd401.ai'
              : 'https://dev.aistudio.psd401.ai',
            'http://localhost:3000', // For local development
          ],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      // Lifecycle rules removed temporarily to match deployed state
      // Will be re-added with OptimizedBucket in future PR
    });

    // Store bucket references
    this.documentsBucket = documentsBucket;
    this.documentsBucketName = documentsBucket.bucketName;

    // Create Storage Lens configuration for analytics
    new StorageLensConfig(this, 'StorageLens', {
      environment: props.environment,
      reportBucket: reportsBucket,
      regions: [cdk.Aws.REGION],
      buckets: [documentsBucket.bucketName],
    });

    // Create cost monitoring and optimization with specific bucket ARNs (IAM least privilege)
    new CostMonitor(this, 'CostMonitor', {
      environment: props.environment as 'dev' | 'prod',
      alertEmail: props.alertEmail,
      monitoredBucketArns: [
        documentsBucket.bucketArn,
        reportsBucket.bucketArn,
      ],
    });

    // Store bucket name in SSM Parameter Store for cross-stack references
    new ssm.StringParameter(this, 'DocumentsBucketParam', {
      parameterName: `/aistudio/${props.environment}/documents-bucket-name`,
      stringValue: documentsBucket.bucketName,
      description: 'S3 bucket name for document storage',
    });

    // CDN/CloudFront temporarily disabled while using direct S3 bucket
    // Will be re-enabled when OptimizedBucket is properly migrated

    // Keep CloudFormation outputs for backward compatibility and monitoring
    // Export names removed to allow stack deletion
    new cdk.CfnOutput(this, 'DocumentsBucketName', {
      value: documentsBucket.bucketName,
      description: 'S3 bucket for document storage',
    });

    new cdk.CfnOutput(this, 'DocumentsBucketArn', {
      value: documentsBucket.bucketArn,
      description: 'S3 bucket ARN for document storage',
    });

    new cdk.CfnOutput(this, 'StorageLensReportsBucket', {
      value: reportsBucket.bucketName,
      description: 'S3 bucket for Storage Lens reports',
    });
  }
}
