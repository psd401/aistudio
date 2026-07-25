import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { ServiceRoleFactory } from "../security";

export interface GoogleContentSyncProps {
  environment: "dev" | "prod";
  documentsBucket: s3.IBucket;
  databaseHost: string;
  databaseSecretArn: string;
  contentProcessingQueue: sqs.IQueue;
  vpc: ec2.IVpc;
  appBaseUrl?: string;
}

/**
 * Isolated, keyless Google Workspace synchronization runtime (#1262).
 *
 * Its execution role name is part of the cross-cloud trust contract. Keep
 * `unified-content-sync-execution-role-{environment}` stable: the GCP WIF
 * provider admits only assumed sessions of those two roles.
 */
export class GoogleContentSync extends Construct {
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly worker: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: GoogleContentSyncProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const physicalFunctionName = `aistudio-${props.environment}-google-content-sync`;

    this.deadLetterQueue = new sqs.Queue(this, "DeadLetterQueue", {
      queueName: `aistudio-${props.environment}-google-content-sync-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: `aistudio-${props.environment}-google-content-sync-queue`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.minutes(15),
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 5,
      },
    });
    for (const resource of [this.queue, this.deadLetterQueue]) {
      cdk.Tags.of(resource).add("Environment", props.environment);
      cdk.Tags.of(resource).add("ManagedBy", "cdk");
    }

    const workerRole = ServiceRoleFactory.createLambdaRole(this, "WorkerRole", {
      // Deliberately omits the physical Lambda suffix; this produces the
      // exact role trusted by the Google WIF provider.
      functionName: "unified-content-sync",
      environment: props.environment,
      region: stack.region,
      account: stack.account,
      vpcEnabled: true,
      sqsQueues: [{ name: this.queue.queueName }],
      additionalPolicies: [
        new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: "GoogleContentWorkerLogs",
              actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
              ],
              resources: [
                `arn:${stack.partition}:logs:${stack.region}:${stack.account}:` +
                  `log-group:/aws/lambda/${physicalFunctionName}:*`,
              ],
            }),
            new iam.PolicyStatement({
              sid: "GoogleContentSecrets",
              actions: [
                "secretsmanager:GetSecretValue",
                "secretsmanager:DescribeSecret",
              ],
              resources: [
                props.databaseSecretArn,
                `arn:${stack.partition}:secretsmanager:${stack.region}:` +
                  `${stack.account}:secret:aistudio/${props.environment}/mcp/token-encryption-key-*`,
                `arn:${stack.partition}:secretsmanager:${stack.region}:` +
                  `${stack.account}:secret:aistudio/${props.environment}/google-content-oauth-*`,
              ],
            }),
            new iam.PolicyStatement({
              sid: "GoogleContentSourceObjects",
              actions: [
                "s3:PutObject",
                "s3:PutObjectTagging",
                "s3:AbortMultipartUpload",
              ],
              resources: [`${props.documentsBucket.bucketArn}/repositories/*`],
            }),
            new iam.PolicyStatement({
              sid: "CanonicalProcessingDispatch",
              actions: [
                "sqs:SendMessage",
                "sqs:GetQueueAttributes",
                "sqs:GetQueueUrl",
              ],
              resources: [props.contentProcessingQueue.queueArn],
            }),
          ],
        }),
      ],
    });

    const workerSecurityGroup = new ec2.SecurityGroup(
      this,
      "WorkerSecurityGroup",
      {
        vpc: props.vpc,
        description:
          "Google content sync access to Aurora and public Google APIs",
        allowAllOutbound: true,
      },
    );
    this.worker = new lambdaNodejs.NodejsFunction(this, "Worker", {
      functionName: physicalFunctionName,
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(
        __dirname,
        "../../../lambdas/google-content-sync/index.ts",
      ),
      handler: "handler",
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
      reservedConcurrentExecutions: props.environment === "prod" ? 5 : 2,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [workerSecurityGroup],
      role: workerRole,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        DOCUMENTS_BUCKET_NAME: props.documentsBucket.bucketName,
        CONTENT_PROCESSING_QUEUE_URL: props.contentProcessingQueue.queueUrl,
        GOOGLE_CONTENT_SYNC_QUEUE_URL: this.queue.queueUrl,
        DATABASE_HOST: props.databaseHost,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
        DATABASE_NAME: "aistudio",
        DATABASE_PORT: "5432",
        ENVIRONMENT: props.environment,
        APP_BASE_URL: props.appBaseUrl ?? "",
        GOOGLE_CONTENT_OAUTH_SECRET_ID: `aistudio/${props.environment}/google-content-oauth`,
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.ESM,
        target: "node20",
        sourceMap: true,
        minify: false,
        externalModules: ["@aws-sdk/*"],
        nodeModules: [
          "@aws-sdk/client-s3",
          "@aws-sdk/client-secrets-manager",
          "@aws-sdk/client-sqs",
          "@aws-sdk/lib-storage",
          "google-auth-library",
        ],
        banner:
          'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
      },
    });
    cdk.Tags.of(this.worker).add("Environment", props.environment);
    cdk.Tags.of(this.worker).add("ManagedBy", "cdk");
    this.worker.addEventSource(
      new lambdaEventSources.SqsEventSource(this.queue, {
        batchSize: 1,
        maxConcurrency: props.environment === "prod" ? 5 : 2,
        reportBatchItemFailures: true,
      }),
    );
    new events.Rule(this, "ScheduledReconciliation", {
      description:
        "Reconcile due Google Workspace connectors and renew watch channels",
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(this.worker)],
    });

    const alarms = [
      new cloudwatch.Alarm(this, "DeadLetterQueueAlarm", {
        alarmName: `aistudio-${props.environment}-google-content-sync-dlq-visible`,
        alarmDescription:
          "Google content synchronization records reached the DLQ",
        metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
          statistic: "Maximum",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, "OldestMessageAlarm", {
        alarmName: `aistudio-${props.environment}-google-content-sync-oldest-message`,
        alarmDescription:
          "Google content synchronization has not drained within 30 minutes",
        metric: this.queue.metricApproximateAgeOfOldestMessage({
          period: cdk.Duration.minutes(5),
          statistic: "Maximum",
        }),
        threshold: cdk.Duration.minutes(30).toSeconds(),
        evaluationPeriods: 2,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, "WorkerErrorAlarm", {
        alarmName: `aistudio-${props.environment}-google-content-sync-worker-errors`,
        alarmDescription:
          "Google content synchronization Lambda reported an unhandled error",
        metric: this.worker.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: "Sum",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];
    const alarmTopic = sns.Topic.fromTopicArn(
      this,
      "MonitoringAlarmTopic",
      stack.formatArn({
        service: "sns",
        resource: `aistudio-${props.environment}-monitoring-alarms`,
      }),
    );
    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);
    for (const alarm of alarms) {
      cdk.Tags.of(alarm).add("Environment", props.environment);
      cdk.Tags.of(alarm).add("ManagedBy", "cdk");
      alarm.addAlarmAction(alarmAction);
    }
  }
}
