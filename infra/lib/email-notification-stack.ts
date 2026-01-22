import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as path from 'path';

export interface EmailNotificationStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
  // Cross-stack dependencies retrieved from SSM Parameter Store
  databaseResourceArn?: string;
  databaseSecretArn?: string;
  // Email configuration - allows different organizations to customize
  emailDomain?: string;
  fromEmail?: string;
  appBaseUrl?: string;
  // SES resource management
  createSesIdentity?: boolean; // Set to false if SES identity already exists
  useDomainIdentity?: boolean; // Use domain identity for prod, email identity for dev
}

export class EmailNotificationStack extends cdk.Stack {
  public readonly notificationSenderFunction: lambda.Function;
  public readonly notificationQueue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: EmailNotificationStackProps) {
    super(scope, id, props);

    // Email configuration with defaults for PSD401
    const emailDomain = props.emailDomain || 'psd401.net';
    const fromEmail = props.fromEmail || `noreply@${emailDomain}`;
    const appBaseUrl = props.appBaseUrl ||
      (props.environment === 'prod' ? 'https://aistudio.psd401.ai' : 'https://dev.aistudio.psd401.ai');

    // Retrieve values from SSM Parameter Store (or use provided props for backward compatibility)
    const databaseResourceArn = props.databaseResourceArn ||
      ssm.StringParameter.valueForStringParameter(
        this, `/aistudio/${props.environment}/db-cluster-arn`
      );

    const databaseSecretArn = props.databaseSecretArn ||
      ssm.StringParameter.valueForStringParameter(
        this, `/aistudio/${props.environment}/db-secret-arn`
      );

    // SES Configuration - Configurable identity creation
    const createSesIdentity = props.createSesIdentity !== false; // Default to true
    const useDomainIdentity = props.useDomainIdentity || (props.environment === 'prod');

    // Only create SES identity if explicitly requested
    if (createSesIdentity) {
      const emailIdentity = new ses.EmailIdentity(this, 'SESEmailIdentity', {
        identity: useDomainIdentity
          ? ses.Identity.domain(emailDomain)
          : ses.Identity.email(fromEmail),
      });

      // Retain the identity if stack is deleted (don't break email functionality)
      emailIdentity.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    }

    // Note: If createSesIdentity is false, assumes the email identity is already verified externally

    // SES Configuration Set for tracking delivery events
    const configurationSet = new ses.ConfigurationSet(this, 'EmailConfigurationSet', {
      configurationSetName: `aistudio-${props.environment}-email-config`,
    });

    // Note: Email templates removed - now using SES v2 direct email sending

    // Dead Letter Queue for failed notification processing
    this.deadLetterQueue = new sqs.Queue(this, 'NotificationDLQ', {
      queueName: `aistudio-${props.environment}-notification-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    // SQS Queue for notification processing
    this.notificationQueue = new sqs.Queue(this, 'NotificationQueue', {
      queueName: `aistudio-${props.environment}-notification-queue`,
      visibilityTimeout: cdk.Duration.minutes(5), // Should be >= Lambda timeout
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3, // Retry failed notifications 3 times
      },
    });

    // CloudWatch Log Group for notification sender
    const notificationLogGroup = new logs.LogGroup(this, 'NotificationLogGroup', {
      logGroupName: `/aws/lambda/aistudio-${props.environment}-notification-sender`,
      retention: props.environment === 'prod' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Create explicit role to avoid CDK's deprecated fromAwsManagedPolicyName
    const notificationSenderRole = new iam.Role(this, 'NotificationSenderRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          'NotificationSenderLambdaBasicExecPolicy',
          'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
        ),
      ],
    });

    // Lambda function for sending email notifications
    this.notificationSenderFunction = new lambda.Function(this, 'NotificationSender', {
      role: notificationSenderRole,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/notification-sender'), {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          local: {
            tryBundle(outputDir: string) {
              const { execSync } = require('child_process');
              const fs = require('fs');
              const path = require('path');
              const sourceDir = path.join(__dirname, '../lambdas/notification-sender');

              try {
                // Build TypeScript
                console.log('Building TypeScript...');
                execSync('npm run build', { cwd: sourceDir, stdio: 'inherit' });

                // Copy the compiled index.js to output root
                const sourceFile = path.join(sourceDir, 'dist', 'index.js');
                const destFile = path.join(outputDir, 'index.js');
                fs.copyFileSync(sourceFile, destFile);

                // Copy package files
                fs.copyFileSync(
                  path.join(sourceDir, 'package.json'),
                  path.join(outputDir, 'package.json')
                );
                fs.copyFileSync(
                  path.join(sourceDir, 'package-lock.json'),
                  path.join(outputDir, 'package-lock.json')
                );

                // Install production dependencies only
                console.log('Installing production dependencies...');
                execSync('npm ci --omit=dev', { cwd: outputDir, stdio: 'inherit' });

                console.log('Bundling complete');
                return true;
              } catch (error) {
                console.error('Local bundling failed:', error);
                return false;
              }
            }
          }
        }
      }),
      functionName: `aistudio-${props.environment}-notification-sender`,
      timeout: cdk.Duration.minutes(3), // Time to process notification and send email
      memorySize: 1024, // Sufficient for email processing
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        DATABASE_RESOURCE_ARN: databaseResourceArn,
        DATABASE_SECRET_ARN: databaseSecretArn,
        DATABASE_NAME: 'aistudio',
        ENVIRONMENT: props.environment,
        SES_CONFIGURATION_SET: configurationSet.configurationSetName,
        SES_FROM_EMAIL: fromEmail,
        APP_BASE_URL: appBaseUrl,
        SES_REGION: 'us-east-1', // SES identities are configured in us-east-1
        MAX_SUMMARY_LENGTH: '10000', // Increased from 2000 to allow more content
      },
      logGroup: notificationLogGroup,
      // Conservative concurrency to avoid SES rate limits
      reservedConcurrentExecutions: props.environment === 'prod' ? 5 : 2,
    });

    // Connect SQS queue to Lambda function
    this.notificationSenderFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(this.notificationQueue, {
        batchSize: 5, // Process up to 5 notifications at once
        maxBatchingWindow: cdk.Duration.seconds(10), // Wait up to 10s to batch
        reportBatchItemFailures: true, // Enable partial batch failure reporting
      })
    );

    // IAM permissions for Lambda function

    // Grant RDS Data API permissions
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
      resources: [databaseSecretArn],
    });

    this.notificationSenderFunction.addToRolePolicy(rdsDataApiPolicy);
    this.notificationSenderFunction.addToRolePolicy(secretsManagerPolicy);

    // Grant SES v2 permissions - SES resources are in us-east-1
    const sesRegion = 'us-east-1'; // SES identities configured region
    const sesPolicy = new iam.PolicyStatement({
      actions: [
        'sesv2:SendEmail',
        'ses:SendEmail',
        'ses:SendRawEmail',
        'ses:PutConfigurationSetEventDestination',
      ],
      resources: [
        `arn:aws:ses:${sesRegion}:${this.account}:identity/${emailDomain}`,
        `arn:aws:ses:${sesRegion}:${this.account}:identity/${fromEmail}`,
        `arn:aws:ses:${sesRegion}:${this.account}:identity/*@${emailDomain}`, // Allow any verified email in domain
        `arn:aws:ses:${sesRegion}:${this.account}:configuration-set/${configurationSet.configurationSetName}`,
      ],
    });

    this.notificationSenderFunction.addToRolePolicy(sesPolicy);

    // Grant SQS permissions (automatically handled by event source, but explicit for clarity)
    this.notificationQueue.grantConsumeMessages(this.notificationSenderFunction);
    this.deadLetterQueue.grantSendMessages(this.notificationSenderFunction);

    // Store important values in SSM Parameter Store for other services
    new ssm.StringParameter(this, 'NotificationQueueUrlParam', {
      parameterName: `/aistudio/${props.environment}/notification-queue-url`,
      stringValue: this.notificationQueue.queueUrl,
      description: 'URL of the notification processing queue',
    });

    new ssm.StringParameter(this, 'NotificationSenderFunctionArnParam', {
      parameterName: `/aistudio/${props.environment}/notification-sender-function-arn`,
      stringValue: this.notificationSenderFunction.functionArn,
      description: 'ARN of the notification sender Lambda function',
    });

    new ssm.StringParameter(this, 'SESConfigurationSetParam', {
      parameterName: `/aistudio/${props.environment}/ses-configuration-set`,
      stringValue: configurationSet.configurationSetName,
      description: 'Name of the SES configuration set for tracking',
    });

    // Outputs
    new cdk.CfnOutput(this, 'NotificationQueueUrlOutput', {
      value: this.notificationQueue.queueUrl,
      description: 'URL of the notification processing queue',
      exportName: `${props.environment}-NotificationQueueUrl`,
    });

    new cdk.CfnOutput(this, 'NotificationSenderFunctionNameOutput', {
      value: this.notificationSenderFunction.functionName,
      description: 'Name of the notification sender Lambda function',
      exportName: `${props.environment}-NotificationSenderFunctionName`,
    });


    new cdk.CfnOutput(this, 'SESConfigurationSetOutput', {
      value: configurationSet.configurationSetName,
      description: 'Name of the SES configuration set',
      exportName: `${props.environment}-SESConfigurationSet`,
    });
  }
}