import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
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
  embeddingDeadLetterQueue: sqs.IQueue;
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
    const dataAutomationProfileArn =
      `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:` +
      "data-automation-profile/us.data-automation-v1";

    const mediaProject = new bedrock.CfnDataAutomationProject(
      this,
      "MediaDataAutomationProject",
      {
        projectName: `aistudio-${props.environment}-repository-media`,
        projectDescription:
          "Canonical repository audio transcripts and video scene intelligence",
        projectType: "ASYNC",
        standardOutputConfiguration: {
          audio: {
            extraction: {
              category: {
                state: "ENABLED",
                types: ["TRANSCRIPT"],
                typeConfiguration: {
                  transcript: {
                    speakerLabeling: { state: "ENABLED" },
                    channelLabeling: { state: "ENABLED" },
                  },
                },
              },
            },
            generativeField: {
              state: "ENABLED",
              types: ["AUDIO_SUMMARY", "TOPIC_SUMMARY"],
            },
          },
          video: {
            extraction: {
              category: {
                state: "ENABLED",
                types: ["TRANSCRIPT", "TEXT_DETECTION"],
              },
              boundingBox: { state: "ENABLED" },
            },
            generativeField: {
              state: "ENABLED",
              types: ["VIDEO_SUMMARY", "CHAPTER_SUMMARY"],
            },
          },
        },
        tags: [
          { key: "Environment", value: props.environment },
          { key: "ManagedBy", value: "cdk" },
        ],
      }
    );

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
      // The durable database job owns the five-attempt processing budget.
      // Queue-level retries are reserved for malformed records or failure-state
      // persistence outages and must not remain invisible for 30 hours.
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 5 },
    });
    for (const resource of [this.deadLetterQueue, this.queue]) {
      cdk.Tags.of(resource).add("Environment", props.environment);
      cdk.Tags.of(resource).add("ManagedBy", "cdk");
    }
    const deadLetterAlarm = new cloudwatch.Alarm(this, "DeadLetterQueueAlarm", {
      alarmName: `aistudio-${props.environment}-content-processing-dlq-visible`,
      alarmDescription:
        "Unified repository content records reached the DLQ and require diagnosis/redrive",
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const oldestMessageAlarm = new cloudwatch.Alarm(this, "OldestMessageAlarm", {
      alarmName: `aistudio-${props.environment}-content-processing-oldest-message`,
      alarmDescription:
        "Unified repository content processing has not drained a message within 30 minutes",
      metric: this.queue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: cdk.Duration.minutes(30).toSeconds(),
      evaluationPeriods: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    for (const alarm of [deadLetterAlarm, oldestMessageAlarm]) {
      cdk.Tags.of(alarm).add("Environment", props.environment);
      cdk.Tags.of(alarm).add("ManagedBy", "cdk");
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
                sid: "CanonicalRepositoryArtifactDiscovery",
                actions: ["s3:ListBucket"],
                resources: [props.documentsBucket.bucketArn],
                conditions: {
                  StringLike: { "s3:prefix": ["repositories/*"] },
                },
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
        // ServiceRoleFactory accepts physical queue names; unresolved ARN
        // tokens would be prefixed a second time and synthesize an invalid ARN.
        // This queue is owned and tagged by this construct, so the factory's
        // resource-tag conditions are guaranteed to match. Embedding dispatch
        // uses an explicit queue-ARN grant below because shared queues may have
        // stack-level tags whose values do not match those conditions.
        sqsQueues: [this.queue.queueName],
        additionalPolicies: [
          new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                sid: "AuroraSecretAccess",
                actions: ["secretsmanager:GetSecretValue"],
                resources: [props.databaseSecretArn],
              }),
              new iam.PolicyStatement({
                sid: "CanonicalEmbeddingDispatch",
                actions: ["sqs:SendMessage"],
                resources: [props.embeddingQueue.queueArn],
              }),
              new iam.PolicyStatement({
                sid: "CanonicalEmbeddingDlqRecovery",
                actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
                resources: [props.embeddingDeadLetterQueue.queueArn],
              }),
              new iam.PolicyStatement({
                sid: "CanonicalProcessingDlqRecovery",
                actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
                resources: [this.deadLetterQueue.queueArn],
              }),
              new iam.PolicyStatement({
                // Do not use ServiceRoleFactory's generic s3Buckets grant here.
                // Its bucket-tag condition is not evaluated for S3 object ARNs,
                // so GetObject fails closed even when the bucket is tagged. This
                // explicit prefix is both narrower and valid for object access.
                sid: "CanonicalRepositoryObjectAccess",
                actions: [
                  "s3:GetObject",
                  "s3:GetObjectVersion",
                  "s3:GetObjectTagging",
                  "s3:PutObject",
                ],
                resources: [
                  `${props.documentsBucket.bucketArn}/repositories/*`,
                ],
              }),
              new iam.PolicyStatement({
                sid: "CanonicalRepositoryArtifactDiscovery",
                actions: ["s3:ListBucket"],
                resources: [props.documentsBucket.bucketArn],
                conditions: {
                  StringLike: { "s3:prefix": ["repositories/*"] },
                },
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
              new iam.PolicyStatement({
                sid: "CanonicalImageCaptioning",
                actions: ["bedrock:InvokeModel"],
                resources: [
                  `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:inference-profile/us.amazon.nova-*-v1:0`,
                  ...["us-east-1", "us-east-2", "us-west-2"].map(
                    (region) =>
                      `arn:${stack.partition}:bedrock:${region}::foundation-model/amazon.nova-*-v1:0`
                  ),
                ],
              }),
              new iam.PolicyStatement({
                sid: "CanonicalMediaAnalysis",
                actions: ["bedrock:InvokeDataAutomationAsync"],
                resources: [
                  mediaProject.attrProjectArn,
                  ...["us-east-1", "us-east-2", "us-west-1", "us-west-2"].map(
                    (region) =>
                      `arn:${stack.partition}:bedrock:${region}:${stack.account}:data-automation-profile/us.data-automation-v1`
                  ),
                ],
              }),
              new iam.PolicyStatement({
                sid: "CanonicalMediaAnalysisStatus",
                actions: ["bedrock:GetDataAutomationStatus"],
                resources: [
                  `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:data-automation-invocation/*`,
                ],
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
        CONTENT_PROCESSING_DLQ_URL: this.deadLetterQueue.queueUrl,
        EMBEDDING_QUEUE_URL: props.embeddingQueue.queueUrl,
        EMBEDDING_DLQ_URL: props.embeddingDeadLetterQueue.queueUrl,
        BDA_DATA_AUTOMATION_PROJECT_ARN: mediaProject.attrProjectArn,
        BDA_DATA_AUTOMATION_PROFILE_ARN: dataAutomationProfileArn,
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
        nodeModules: [
          "sharp",
          // pdf-parse's ESM package uses runtime initialization that esbuild
          // rewrites incorrectly when inlined (PDFParse becomes a non-class).
          // Install the pinned package for Linux/ARM64 and load it natively.
          "pdf-parse",
          "@aws-sdk/client-bedrock-data-automation-runtime",
        ],
        // CDK's local bundler installs native modules for the synth host. Re-run
        // the pinned install for the Lambda target so macOS and x64 synths both
        // package Sharp's Linux ARM64 libvips binary without requiring Docker.
        commandHooks: {
          afterBundling(_inputDir, outputDir) {
            return [
              `cd "${outputDir}" && bun install --frozen-lockfile --os linux --cpu arm64 --backend copyfile`,
            ];
          },
          beforeBundling() {
            return [];
          },
          beforeInstall() {
            return [];
          },
        },
        banner:
          'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
      },
    });
    cdk.Tags.of(this.worker).add("Environment", props.environment);
    cdk.Tags.of(this.worker).add("ManagedBy", "cdk");
    const workerErrorAlarm = new cloudwatch.Alarm(this, "WorkerErrorAlarm", {
      alarmName: `aistudio-${props.environment}-content-processing-worker-errors`,
      alarmDescription:
        "Unified repository content processing or scheduled recovery failed",
      metric: this.worker.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    cdk.Tags.of(workerErrorAlarm).add("Environment", props.environment);
    cdk.Tags.of(workerErrorAlarm).add("ManagedBy", "cdk");

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
