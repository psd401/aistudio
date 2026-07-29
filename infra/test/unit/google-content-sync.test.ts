import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { GoogleContentSync } from "../../lib/constructs/processing/google-content-sync";

function synthesize(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "GoogleContentSyncTest", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const vpc = new ec2.Vpc(stack, "Vpc", { maxAzs: 2, natGateways: 1 });
  const documentsBucket = s3.Bucket.fromBucketName(
    stack,
    "DocumentsBucket",
    "aistudio-dev-documents",
  );
  const processingQueue = new sqs.Queue(stack, "ProcessingQueue", {
    queueName: "aistudio-dev-content-processing-queue",
  });

  new GoogleContentSync(stack, "GoogleContentSync", {
    environment: "dev",
    documentsBucket,
    databaseHost: "database.example.test",
    databaseSecretArn:
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev-db-AbCdEf",
    googleContentOAuthSecretArn:
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio/dev/google-content-oauth-AbCdEf",
    contentProcessingQueue: processingQueue,
    vpc,
    appBaseUrl: "https://dev.aistudio.example.test",
  });
  return Template.fromStack(stack);
}

describe("GoogleContentSync", () => {
  const template = synthesize();

  test("uses the exact keyless WIF execution role contract", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "unified-content-sync-execution-role-dev",
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "lambda.amazonaws.com" },
          }),
        ]),
      },
    });
  });

  test("deploys an isolated queue, DLQ, schedule, and partial batch handling", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "aistudio-dev-google-content-sync-queue",
      SqsManagedSseEnabled: true,
      VisibilityTimeout: 900,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "aistudio-dev-google-content-sync-dlq",
      MessageRetentionPeriod: 1_209_600,
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: { MaximumConcurrency: 2 },
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(5 minutes)",
      State: "ENABLED",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          GOOGLE_CONTENT_SYNC_QUEUE_URL: Match.anyValue(),
        }),
      },
    });
  });

  test("keeps source storage and downstream dispatch least-privileged", () => {
    const policies = JSON.stringify(template.findResources("AWS::IAM::Role"));
    expect(policies).toContain("GoogleContentSourceObjects");
    expect(policies).toContain(":s3:::aistudio-dev-documents/repositories/*");
    expect(policies).toContain("CanonicalProcessingDispatch");
    expect(policies).toContain("sqs:SendMessage");
    expect(policies).toContain("GoogleContentSyncQueue");
    expect(policies).toContain("aistudio/dev/mcp/token-encryption-key-");
    expect(policies).toContain("aistudio/dev/google-content-oauth-AbCdEf");
    expect(policies).not.toContain("iam:CreateAccessKey");
  });

  test("provides health alarms for worker, staleness, and dead letters", () => {
    for (const alarmName of [
      "aistudio-dev-google-content-sync-dlq-visible",
      "aistudio-dev-google-content-sync-oldest-message",
      "aistudio-dev-google-content-sync-worker-errors",
    ]) {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: alarmName,
        TreatMissingData: "notBreaching",
        AlarmActions: Match.anyValue(),
      });
    }
    expect(
      JSON.stringify(template.findResources("AWS::CloudWatch::Alarm")),
    ).toContain("aistudio-dev-monitoring-alarms");
  });
});
