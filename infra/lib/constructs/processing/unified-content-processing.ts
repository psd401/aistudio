import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as guardduty from "aws-cdk-lib/aws-guardduty";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { ServiceRoleFactory } from "../security";

export interface UnifiedContentProcessingProps {
  environment: "dev" | "prod";
  documentsBucket: s3.IBucket;
  databaseHost: string;
  databaseSecretArn: string;
  embeddingQueue: sqs.IQueue;
  vpc: ec2.IVpc;
}

/**
 * Canonical repository ingestion worker, durable queue, and quarantine scanner.
 * Kept as an independently synthesizable construct so the security contract can
 * be regression-tested without bundling every legacy processor in the stack.
 */
export class UnifiedContentProcessing extends Construct {
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly worker: lambdaNodejs.NodejsFunction;

  constructor(
    scope: Construct,
    id: string,
    props: UnifiedContentProcessingProps
  ) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const functionName =
      `aistudio-${props.environment}-unified-content-processor`;

    this.deadLetterQueue = new sqs.Queue(this, "DeadLetterQueue", {
      queueName: `aistudio-${props.environment}-content-processing-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: `aistudio-${props.environment}-content-processing-queue`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      // AWS recommends at least six times the Lambda timeout for SQS event
      // sources so throttling/backoff cannot expose the same record mid-run.
      visibilityTimeout: cdk.Duration.minutes(90),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 20 },
    });
    for (const resource of [this.deadLetterQueue, this.queue]) {
      cdk.Tags.of(resource).add("Environment", props.environment);
      cdk.Tags.of(resource).add("ManagedBy", "cdk");
    }

    const malwareProtectionRole = new iam.Role(
      this,
      "MalwareProtectionRole",
      {
        assumedBy: new iam.ServicePrincipal(
          "malware-protection-plan.guardduty.amazonaws.com"
        ),
        description:
          `GuardDuty repository-object scanner (${props.environment})`,
        inlinePolicies: {
          MalwareProtection: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                sid: "AllowManagedRuleToSendS3EventsToGuardDuty",
                actions: [
                  "events:PutRule",
                  "events:DeleteRule",
                  "events:PutTargets",
                  "events:RemoveTargets",
                ],
                resources: [
                  `arn:aws:events:${stack.region}:${stack.account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`,
                ],
                conditions: {
                  StringLike: {
                    "events:ManagedBy":
                      "malware-protection-plan.guardduty.amazonaws.com",
                  },
                },
              }),
              new iam.PolicyStatement({
                sid: "AllowGuardDutyToMonitorEventBridgeManagedRule",
                actions: ["events:DescribeRule", "events:ListTargetsByRule"],
                resources: [
                  `arn:aws:events:${stack.region}:${stack.account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`,
                ],
              }),
              new iam.PolicyStatement({
                sid: "AllowRepositoryObjectScanAndTag",
                actions: [
                  "s3:GetObject",
                  "s3:GetObjectVersion",
                  "s3:GetObjectTagging",
                  "s3:GetObjectVersionTagging",
                  "s3:PutObjectTagging",
                  "s3:PutObjectVersionTagging",
                ],
                resources: [
                  `${props.documentsBucket.bucketArn}/repositories/*`,
                ],
              }),
              new iam.PolicyStatement({
                sid: "AllowEnableS3EventBridgeEvents",
                actions: [
                  "s3:PutBucketNotification",
                  "s3:GetBucketNotification",
                ],
                resources: [props.documentsBucket.bucketArn],
              }),
              new iam.PolicyStatement({
                sid: "AllowPutValidationObject",
                actions: ["s3:PutObject"],
                resources: [
                  `${props.documentsBucket.bucketArn}/malware-protection-resource-validation-object`,
                ],
              }),
              new iam.PolicyStatement({
                sid: "AllowCheckBucketOwnership",
                actions: ["s3:ListBucket"],
                resources: [props.documentsBucket.bucketArn],
              }),
            ],
          }),
        },
      }
    );
    cdk.Tags.of(malwareProtectionRole).add("Environment", props.environment);
    cdk.Tags.of(malwareProtectionRole).add("ManagedBy", "cdk");

    const malwareProtectionPlan = new guardduty.CfnMalwareProtectionPlan(
      this,
      "MalwareProtectionPlan",
      {
        role: malwareProtectionRole.roleArn,
        protectedResource: {
          s3Bucket: {
            bucketName: props.documentsBucket.bucketName,
            objectPrefixes: ["repositories/"],
          },
        },
        actions: { tagging: { status: "ENABLED" } },
        tags: [
          { key: "Environment", value: props.environment },
          { key: "ManagedBy", value: "cdk" },
        ],
      }
    );
    malwareProtectionPlan.node.addDependency(malwareProtectionRole);

    const workerRole = ServiceRoleFactory.createLambdaRole(
      this,
      "WorkerRole",
      {
        functionName,
        environment: props.environment,
        region: stack.region,
        account: stack.account,
        vpcEnabled: true,
        s3Buckets: [props.documentsBucket.bucketName],
        // ServiceRoleFactory accepts physical queue names; unresolved ARN
        // tokens would be prefixed a second time and synthesize an invalid ARN.
        sqsQueues: [this.queue.queueName, props.embeddingQueue.queueName],
        additionalPolicies: [
          new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                sid: "AuroraSecretAccess",
                actions: ["secretsmanager:GetSecretValue"],
                resources: [props.databaseSecretArn],
              }),
              new iam.PolicyStatement({
                sid: "ReadGuardDutyObjectScanTag",
                actions: ["s3:GetObjectTagging"],
                resources: [
                  `${props.documentsBucket.bucketArn}/repositories/*`,
                ],
              }),
              // Textract asynchronous OCR does not support resource-level IAM.
              new iam.PolicyStatement({
                sid: "CanonicalPdfOcr",
                actions: [
                  "textract:StartDocumentTextDetection",
                  "textract:GetDocumentTextDetection",
                ],
                resources: ["*"],
              }),
            ],
          }),
        ],
      }
    );
    const workerSecurityGroup = new ec2.SecurityGroup(
      this,
      "WorkerSecurityGroup",
      {
        vpc: props.vpc,
        description: "Unified content processor access to Aurora and AWS APIs",
        allowAllOutbound: true,
      }
    );

    this.worker = new lambdaNodejs.NodejsFunction(this, "Worker", {
      functionName,
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(
        __dirname,
        "../../../lambdas/unified-content-processor/index.ts"
      ),
      handler: "handler",
      timeout: cdk.Duration.minutes(15),
      memorySize: 3008,
      reservedConcurrentExecutions: props.environment === "prod" ? 10 : 3,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [workerSecurityGroup],
      role: workerRole,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        DOCUMENTS_BUCKET_NAME: props.documentsBucket.bucketName,
        CONTENT_PROCESSING_QUEUE_URL: this.queue.queueUrl,
        EMBEDDING_QUEUE_URL: props.embeddingQueue.queueUrl,
        DATABASE_HOST: props.databaseHost,
        DATABASE_SECRET_ARN: props.databaseSecretArn,
        DATABASE_NAME: "aistudio",
        DATABASE_PORT: "5432",
        ENVIRONMENT: props.environment,
      },
      bundling: {
        format: lambdaNodejs.OutputFormat.ESM,
        target: "node20",
        sourceMap: true,
        minify: false,
        externalModules: ["@aws-sdk/*"],
        banner:
          'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
      },
    });
    cdk.Tags.of(this.worker).add("Environment", props.environment);
    cdk.Tags.of(this.worker).add("ManagedBy", "cdk");

    this.worker.addEventSource(
      new lambdaEventSources.SqsEventSource(this.queue, {
        batchSize: 1,
        maxConcurrency: props.environment === "prod" ? 10 : 3,
        reportBatchItemFailures: true,
      })
    );
    new events.Rule(this, "PendingJobSweep", {
      description:
        "Recover and dispatch durable unified-content jobs left pending after send failures",
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(this.worker)],
    });
  }
}
