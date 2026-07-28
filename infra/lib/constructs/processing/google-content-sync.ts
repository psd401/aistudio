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
  googleContentOAuthSecretArn: string;
  contentProcessingQueue: sqs.IQueue;
  vpc: ec2.IVpc;
  appBaseUrl?: string;
}

function createSyncQueues(scope: Construct, environment: "dev" | "prod") {
  const deadLetterQueue = new sqs.Queue(scope, "DeadLetterQueue", {
    queueName: `aistudio-${environment}-google-content-sync-dlq`,
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    retentionPeriod: cdk.Duration.days(14),
  });
  const queue = new sqs.Queue(scope, "Queue", {
    queueName: `aistudio-${environment}-google-content-sync-queue`,
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    visibilityTimeout: cdk.Duration.minutes(15),
    deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 5 },
  });
  for (const resource of [queue, deadLetterQueue]) {
    cdk.Tags.of(resource).add("Environment", environment);
    cdk.Tags.of(resource).add("ManagedBy", "cdk");
  }
  return { deadLetterQueue, queue };
}

function createWorkerRole(
  scope: Construct,
  props: GoogleContentSyncProps,
  queue: sqs.Queue,
  physicalFunctionName: string,
) {
  const stack = cdk.Stack.of(scope);
  return ServiceRoleFactory.createLambdaRole(scope, "WorkerRole", {
    functionName: "unified-content-sync",
    environment: props.environment,
    region: stack.region,
    account: stack.account,
    vpcEnabled: true,
    sqsQueues: [{ name: queue.queueName }],
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
              props.googleContentOAuthSecretArn,
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
}

interface WorkerOptions {
  physicalFunctionName: string;
  props: GoogleContentSyncProps;
  queue: sqs.Queue;
  role: iam.IRole;
  scope: Construct;
}

function createSyncWorker(options: WorkerOptions) {
  const { physicalFunctionName, props, queue, role, scope } = options;
  const securityGroup = new ec2.SecurityGroup(scope, "WorkerSecurityGroup", {
    vpc: props.vpc,
    description: "Google content sync access to Aurora and public Google APIs",
    allowAllOutbound: true,
  });
  const worker = new lambdaNodejs.NodejsFunction(scope, "Worker", {
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
    securityGroups: [securityGroup],
    role,
    environment: {
      NODE_OPTIONS: "--enable-source-maps",
      DOCUMENTS_BUCKET_NAME: props.documentsBucket.bucketName,
      CONTENT_PROCESSING_QUEUE_URL: props.contentProcessingQueue.queueUrl,
      GOOGLE_CONTENT_SYNC_QUEUE_URL: queue.queueUrl,
      DATABASE_HOST: props.databaseHost,
      DATABASE_SECRET_ARN: props.databaseSecretArn,
      DATABASE_NAME: "aistudio",
      DATABASE_PORT: "5432",
      ENVIRONMENT: props.environment,
      APP_BASE_URL: props.appBaseUrl ?? "",
      GOOGLE_CONTENT_OAUTH_SECRET_ID: props.googleContentOAuthSecretArn,
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
  cdk.Tags.of(worker).add("Environment", props.environment);
  cdk.Tags.of(worker).add("ManagedBy", "cdk");
  worker.addEventSource(
    new lambdaEventSources.SqsEventSource(queue, {
      batchSize: 1,
      maxConcurrency: props.environment === "prod" ? 5 : 2,
      reportBatchItemFailures: true,
    }),
  );
  new events.Rule(scope, "ScheduledReconciliation", {
    description:
      "Reconcile due Google Workspace connectors and renew watch channels",
    schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    targets: [new eventsTargets.LambdaFunction(worker)],
  });
  return worker;
}

function addSyncAlarms(
  scope: Construct,
  environment: "dev" | "prod",
  queue: sqs.Queue,
  deadLetterQueue: sqs.Queue,
  worker: lambdaNodejs.NodejsFunction,
) {
  const alarms = [
    new cloudwatch.Alarm(scope, "DeadLetterQueueAlarm", {
      alarmName: `aistudio-${environment}-google-content-sync-dlq-visible`,
      alarmDescription: "Google content synchronization records reached the DLQ",
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }),
    new cloudwatch.Alarm(scope, "OldestMessageAlarm", {
      alarmName: `aistudio-${environment}-google-content-sync-oldest-message`,
      alarmDescription:
        "Google content synchronization has not drained within 30 minutes",
      metric: queue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: cdk.Duration.minutes(30).toSeconds(),
      evaluationPeriods: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }),
    new cloudwatch.Alarm(scope, "WorkerErrorAlarm", {
      alarmName: `aistudio-${environment}-google-content-sync-worker-errors`,
      alarmDescription:
        "Google content synchronization Lambda reported an unhandled error",
      metric: worker.metricErrors({
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
  const stack = cdk.Stack.of(scope);
  const alarmTopic = sns.Topic.fromTopicArn(
    scope,
    "MonitoringAlarmTopic",
    stack.formatArn({
      service: "sns",
      resource: `aistudio-${environment}-monitoring-alarms`,
    }),
  );
  const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);
  for (const alarm of alarms) {
    cdk.Tags.of(alarm).add("Environment", environment);
    cdk.Tags.of(alarm).add("ManagedBy", "cdk");
    alarm.addAlarmAction(alarmAction);
  }
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
    const physicalFunctionName = `aistudio-${props.environment}-google-content-sync`;
    const queues = createSyncQueues(this, props.environment);
    this.queue = queues.queue;
    this.deadLetterQueue = queues.deadLetterQueue;
    const workerRole = createWorkerRole(
      this,
      props,
      this.queue,
      physicalFunctionName,
    );
    this.worker = createSyncWorker({
      physicalFunctionName,
      props,
      queue: this.queue,
      role: workerRole,
      scope: this,
    });
    addSyncAlarms(
      this,
      props.environment,
      this.queue,
      this.deadLetterQueue,
      this.worker,
    );
  }
}
