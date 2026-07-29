import * as path from "node:path";
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
  legacyMigrationReadEnabled?: boolean;
  vpc: ec2.IVpc;
}

class UnifiedContentResources {
  stack!: cdk.Stack;
  functionName!: string;
  dataAutomationProfileArn!: string;
  mediaProject!: bedrock.CfnDataAutomationProject;
  deadLetterQueue!: sqs.Queue;
  queue!: sqs.Queue;
  workerRole!: iam.Role;
  workerSecurityGroup!: ec2.SecurityGroup;
  worker!: lambdaNodejs.NodejsFunction;
  dashboard!: cloudwatch.Dashboard;
}

function workerConcurrency(environment: "dev" | "prod"): {
  reserved: number;
  queueMaximum: number;
} {
  const reserved = environment === "prod" ? 10 : 3;
  // EventBridge invokes this function every minute for durable recovery and
  // maintenance. Keep one execution outside the SQS poller's ceiling so a
  // sustained content queue cannot starve recurring work.
  return { reserved, queueMaximum: reserved - 1 };
}

/**
 * Canonical repository ingestion worker, durable queue, and quarantine scanner.
 * Kept as an independently synthesizable construct so the security contract can
 * be regression-tested without bundling every legacy processor in the stack.
 */
export class UnifiedContentProcessing extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly worker: lambdaNodejs.NodejsFunction;

  constructor(
    scope: Construct,
    id: string,
    props: UnifiedContentProcessingProps,
  ) {
    super(scope, id);

    const resources = new UnifiedContentResources();
    this.createFoundation(props, resources);
    this.createQueuesAndAlarms(props, resources);
    this.createMalwareProtection(props, resources);
    this.createWorkerInfrastructure(props, resources);
    this.createWorker(props, resources);
    this.configureWorkerTriggers(props, resources);
    this.createOperationalDashboard(props, resources);

    this.deadLetterQueue = resources.deadLetterQueue;
    this.queue = resources.queue;
    this.worker = resources.worker;
    this.dashboard = resources.dashboard;
  }

  private createFoundation(
    props: UnifiedContentProcessingProps,
    resources: UnifiedContentResources
  ): void {
    resources.stack = cdk.Stack.of(this);
    resources.functionName =
      `aistudio-${props.environment}-unified-content-processor`;
    resources.dataAutomationProfileArn =
      `arn:${resources.stack.partition}:bedrock:${resources.stack.region}:${resources.stack.account}:` +
      "data-automation-profile/us.data-automation-v1";

    resources.mediaProject = new bedrock.CfnDataAutomationProject(
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
      },
    );
  }

  private createQueuesAndAlarms(
    props: UnifiedContentProcessingProps,
    resources: UnifiedContentResources
  ): void {
    resources.deadLetterQueue = new sqs.Queue(this, "DeadLetterQueue", {
      queueName: `aistudio-${props.environment}-content-processing-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });
    resources.queue = new sqs.Queue(this, "Queue", {
      queueName: `aistudio-${props.environment}-content-processing-queue`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      // AWS recommends at least six times the Lambda timeout for SQS event
      // sources so throttling/backoff cannot expose the same record mid-run.
      visibilityTimeout: cdk.Duration.minutes(90),
      // The durable database job owns the five-attempt processing budget.
      // Queue-level retries are reserved for malformed records or failure-state
      // persistence outages and must not remain invisible for 30 hours.
      deadLetterQueue: { queue: resources.deadLetterQueue, maxReceiveCount: 5 },
    });
    for (const resource of [resources.deadLetterQueue, resources.queue]) {
      cdk.Tags.of(resource).add("Environment", props.environment);
      cdk.Tags.of(resource).add("ManagedBy", "cdk");
    }
    const deadLetterAlarm = new cloudwatch.Alarm(this, "DeadLetterQueueAlarm", {
      alarmName: `aistudio-${props.environment}-content-processing-dlq-visible`,
      alarmDescription:
        "Unified repository content records reached the DLQ and require diagnosis/redrive",
      metric: resources.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
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
      metric: resources.queue.metricApproximateAgeOfOldestMessage({
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
  }

  private createMalwareProtection(
    props: UnifiedContentProcessingProps,
    resources: UnifiedContentResources
  ): void {
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
                  `arn:aws:events:${resources.stack.region}:${resources.stack.account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`,
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
                  `arn:aws:events:${resources.stack.region}:${resources.stack.account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`,
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
      },
    );
    malwareProtectionPlan.node.addDependency(malwareProtectionRole);
  }

  private createWorkerInfrastructure(
    props: UnifiedContentProcessingProps,
    resources: UnifiedContentResources
  ): void {
    resources.workerRole = ServiceRoleFactory.createLambdaRole(
      this,
      "WorkerRole",
      {
        functionName: resources.functionName,
        environment: props.environment,
        region: resources.stack.region,
        account: resources.stack.account,
        vpcEnabled: true,
        // ServiceRoleFactory accepts physical queue names; unresolved ARN
        // tokens would be prefixed a second time and synthesize an invalid ARN.
        // This queue is owned and tagged by this construct, so the factory's
        // resource-tag conditions are guaranteed to match. Embedding dispatch
        // uses an explicit queue-ARN grant below because shared queues may have
        // stack-level tags whose values do not match those conditions.
        sqsQueues: [{ name: resources.queue.queueName }],
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
                resources: [resources.deadLetterQueue.queueArn],
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
                  "s3:PutObjectTagging",
                  "s3:DeleteObject",
                  "s3:DeleteObjectVersion",
                  "s3:AbortMultipartUpload",
                ],
                resources: [
                  `${props.documentsBucket.bucketArn}/repositories/*`,
                ],
              }),
              ...(props.legacyMigrationReadEnabled !== false
                ? [
                    new iam.PolicyStatement({
                      // #1267 backfill reads historical Nexus/document objects
                      // whose pre-canonical keys were user/job scoped. The
                      // retirement assembly removes this temporary broad read.
                      sid: "LegacyContentMigrationRead",
                      actions: ["s3:GetObject", "s3:GetObjectVersion"],
                      resources: [`${props.documentsBucket.bucketArn}/*`],
                    }),
                    new iam.PolicyStatement({
                      // S3 reports a missing legacy object as AccessDenied
                      // unless the caller can list the bucket. Historical keys
                      // predate repositories/, so this retirement-gated grant
                      // cannot be prefix-restricted.
                      sid: "LegacyContentMigrationDiscovery",
                      actions: ["s3:ListBucket"],
                      resources: [props.documentsBucket.bucketArn],
                    }),
                  ]
                : []),
              new iam.PolicyStatement({
                sid: "CanonicalRepositoryArtifactDiscovery",
                actions: ["s3:ListBucket", "s3:ListBucketVersions"],
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
                  `arn:${resources.stack.partition}:bedrock:${resources.stack.region}:${resources.stack.account}:inference-profile/us.amazon.nova-*-v1:0`,
                  ...["us-east-1", "us-east-2", "us-west-2"].map(
                    (region) =>
                      `arn:${resources.stack.partition}:bedrock:${region}::foundation-model/amazon.nova-*-v1:0`
                  ),
                ],
              }),
              new iam.PolicyStatement({
                sid: "CanonicalMediaAnalysis",
                actions: ["bedrock:InvokeDataAutomationAsync"],
                resources: [
                  resources.mediaProject.attrProjectArn,
                  // The runtime authorizes creation of the asynchronous job
                  // against the invocation ARN as well as the selected
                  // project/profile. Without this resource the live service
                  // rejects InvokeDataAutomationAsync before returning the ARN.
                  `arn:${resources.stack.partition}:bedrock:${resources.stack.region}:${resources.stack.account}:data-automation-invocation/*`,
                  ...["us-east-1", "us-east-2", "us-west-1", "us-west-2"].map(
                    (region) =>
                      `arn:${resources.stack.partition}:bedrock:${region}:${resources.stack.account}:data-automation-profile/us.data-automation-v1`
                  ),
                ],
              }),
              new iam.PolicyStatement({
                sid: "CanonicalMediaAnalysisStatus",
                actions: ["bedrock:GetDataAutomationStatus"],
                resources: [
                  `arn:${resources.stack.partition}:bedrock:${resources.stack.region}:${resources.stack.account}:data-automation-invocation/*`,
                ],
              }),
              new iam.PolicyStatement({
                sid: "PublishUnifiedContentOperationalMetrics",
                actions: ["cloudwatch:PutMetricData"],
                resources: ["*"],
                conditions: {
                  StringEquals: {
                    "cloudwatch:namespace": "AIStudio/UnifiedContent",
                  },
                },
              }),
            ],
          }),
        ],
      }
    );
    resources.workerSecurityGroup = new ec2.SecurityGroup(
      this,
      "WorkerSecurityGroup",
      {
        vpc: props.vpc,
        description: "Unified content processor access to Aurora and AWS APIs",
        allowAllOutbound: true,
      },
    );
  }

  private createWorker(
    props: UnifiedContentProcessingProps,
    resources: UnifiedContentResources
  ): void {
    const concurrency = workerConcurrency(props.environment);
    resources.worker = new lambdaNodejs.NodejsFunction(this, "Worker", {
      functionName: resources.functionName,
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(
        __dirname,
        "../../../lambdas/unified-content-processor/index.ts",
      ),
      handler: "handler",
      timeout: cdk.Duration.minutes(15),
      memorySize: 3008,
      reservedConcurrentExecutions: concurrency.reserved,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [resources.workerSecurityGroup],
      role: resources.workerRole,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        DOCUMENTS_BUCKET_NAME: props.documentsBucket.bucketName,
        CONTENT_PROCESSING_QUEUE_URL: resources.queue.queueUrl,
        CONTENT_PROCESSING_DLQ_URL: resources.deadLetterQueue.queueUrl,
        EMBEDDING_QUEUE_URL: props.embeddingQueue.queueUrl,
        EMBEDDING_DLQ_URL: props.embeddingDeadLetterQueue.queueUrl,
        BDA_DATA_AUTOMATION_PROJECT_ARN: resources.mediaProject.attrProjectArn,
        BDA_DATA_AUTOMATION_PROFILE_ARN: resources.dataAutomationProfileArn,
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
          "@aws-sdk/client-cloudwatch",
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
    cdk.Tags.of(resources.worker).add("Environment", props.environment);
    cdk.Tags.of(resources.worker).add("ManagedBy", "cdk");
    const workerErrorAlarm = new cloudwatch.Alarm(this, "WorkerErrorAlarm", {
      alarmName: `aistudio-${props.environment}-content-processing-worker-errors`,
      alarmDescription:
        "Unified repository content processing or scheduled recovery failed",
      metric: resources.worker.metricErrors({
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
  }

  private configureWorkerTriggers(
    props: UnifiedContentProcessingProps,
    resources: UnifiedContentResources
  ): void {
    const concurrency = workerConcurrency(props.environment);
    resources.worker.addEventSource(
      new lambdaEventSources.SqsEventSource(resources.queue, {
        batchSize: 1,
        maxConcurrency: concurrency.queueMaximum,
        reportBatchItemFailures: true,
      }),
    );
    new events.Rule(this, "PendingJobSweep", {
      description:
        "Recover and dispatch durable unified-content jobs left pending after send failures",
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(resources.worker)],
    });
  }

  private createOperationalDashboard(
    props: UnifiedContentProcessingProps,
    resources: UnifiedContentResources
  ): void {
    const operationalMetric = (
      metricName: string,
      statistic = "Maximum"
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: "AIStudio/UnifiedContent",
        metricName,
        dimensionsMap: { Environment: props.environment },
        period: cdk.Duration.minutes(5),
        statistic,
      });
    resources.dashboard = new cloudwatch.Dashboard(
      this,
      "OperationalDashboard",
      {
        dashboardName: `aistudio-${props.environment}-unified-content`,
      }
    );
    resources.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Pipeline state and stale indexes",
        left: [
          operationalMetric("PendingJobs"),
          operationalMetric("FailedJobs24h"),
          operationalMetric("StaleRepositories"),
        ],
        right: [operationalMetric("EstimatedProcessingCostUsd24h")],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Migration reconciliation",
        left: [
          operationalMetric("MigrationVerified"),
          operationalMetric("MigrationMismatches"),
          operationalMetric("MigrationFailed"),
          operationalMetric("MigrationUnrecoverable"),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Retrieval shadow parity",
        left: [operationalMetric("RetrievalShadowObservations24h")],
        right: [operationalMetric("RetrievalOverlapRatio24h", "Average")],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Canonical queue health",
        left: [
          resources.queue.metricApproximateNumberOfMessagesVisible({
            statistic: "Maximum",
          }),
          resources.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
            statistic: "Maximum",
          }),
        ],
        right: [
          resources.queue.metricApproximateAgeOfOldestMessage({
            statistic: "Maximum",
          }),
        ],
        width: 12,
      })
    );
    const migrationBlockerAlarm = new cloudwatch.Alarm(
      this,
      "MigrationBlockerAlarm",
      {
        alarmName: `aistudio-${props.environment}-content-migration-blockers`,
        alarmDescription:
          "Unified-content migration has failed, unrecoverable, or mismatched sources",
        metric: new cloudwatch.MathExpression({
          expression: "failed + unrecoverable + mismatches",
          usingMetrics: {
            failed: operationalMetric("MigrationFailed"),
            unrecoverable: operationalMetric("MigrationUnrecoverable"),
            mismatches: operationalMetric("MigrationMismatches"),
          },
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );
    const staleRepositoryAlarm = new cloudwatch.Alarm(
      this,
      "StaleRepositoryAlarm",
      {
        alarmName: `aistudio-${props.environment}-content-stale-repositories`,
        alarmDescription:
          "Active repositories have canonical content but no active index generation",
        metric: operationalMetric("StaleRepositories"),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );
    const connectorFailureAlarm = new cloudwatch.Alarm(
      this,
      "ConnectorFailureAlarm",
      {
        alarmName: `aistudio-${props.environment}-content-connector-failures`,
        alarmDescription:
          "One or more canonical content connectors are degraded or retrying",
        metric: operationalMetric("ConnectorFailures"),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );
    for (const alarm of [
      migrationBlockerAlarm,
      staleRepositoryAlarm,
      connectorFailureAlarm,
    ]) {
      cdk.Tags.of(alarm).add("Environment", props.environment);
      cdk.Tags.of(alarm).add("ManagedBy", "cdk");
    }
    cdk.Tags.of(resources.dashboard).add("Environment", props.environment);
    cdk.Tags.of(resources.dashboard).add("ManagedBy", "cdk");
  }
}
