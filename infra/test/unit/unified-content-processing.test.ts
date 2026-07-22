import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { UnifiedContentProcessing } from "../../lib/constructs/processing/unified-content-processing";

function synthesize(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "UnifiedContentTest", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const vpc = new ec2.Vpc(stack, "Vpc", { maxAzs: 2, natGateways: 1 });
  const documentsBucket = s3.Bucket.fromBucketName(
    stack,
    "DocumentsBucket",
    "aistudio-dev-documents"
  );
  const embeddingQueue = new sqs.Queue(stack, "EmbeddingQueue", {
    queueName: "aistudio-dev-embedding-queue",
  });
  cdk.Tags.of(embeddingQueue).add("Environment", "dev");
  cdk.Tags.of(embeddingQueue).add("ManagedBy", "cdk");

  new UnifiedContentProcessing(stack, "UnifiedContent", {
    environment: "dev",
    documentsBucket,
    databaseHost: "database.example.test",
    databaseSecretArn:
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev-db-AbCdEf",
    embeddingQueue,
    vpc,
  });
  return Template.fromStack(stack);
}

describe("UnifiedContentProcessing", () => {
  const template = synthesize();

  test("deploys an encrypted durable queue and bounded DLQ retries", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "aistudio-dev-content-processing-queue",
      SqsManagedSseEnabled: true,
      VisibilityTimeout: 5_400,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 20 }),
      Tags: Match.arrayWith([
        { Key: "Environment", Value: "dev" },
        { Key: "ManagedBy", Value: "cdk" },
      ]),
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "aistudio-dev-content-processing-dlq",
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 1_209_600,
    });
  });

  test("scans only canonical repository objects and tags the verdict", () => {
    template.hasResourceProperties("AWS::GuardDuty::MalwareProtectionPlan", {
      Actions: { Tagging: { Status: "ENABLED" } },
      ProtectedResource: {
        S3Bucket: {
          BucketName: "aistudio-dev-documents",
          ObjectPrefixes: ["repositories/"],
        },
      },
      Role: Match.anyValue(),
    });
    const iamResources = JSON.stringify({
      roles: template.findResources("AWS::IAM::Role"),
      policies: template.findResources("AWS::IAM::Policy"),
    });
    expect(iamResources).toContain("AllowRepositoryObjectScanAndTag");
    expect(iamResources).toContain(
      ":s3:::aistudio-dev-documents/repositories/*"
    );
    expect(iamResources).toContain("AllowPutValidationObject");
    expect(iamResources).toContain(
      ":s3:::aistudio-dev-documents/malware-protection-resource-validation-object"
    );
  });

  test("bundles the worker with its queues, VPC, and recovery schedule", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "aistudio-dev-unified-content-processor",
      Runtime: "nodejs20.x",
      Architectures: ["arm64"],
      MemorySize: 3008,
      Timeout: 900,
      ReservedConcurrentExecutions: 3,
      Environment: {
        Variables: Match.objectLike({
          DOCUMENTS_BUCKET_NAME: "aistudio-dev-documents",
          DATABASE_HOST: "database.example.test",
          DATABASE_NAME: "aistudio",
        }),
      },
      VpcConfig: Match.objectLike({ SecurityGroupIds: Match.anyValue() }),
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: { MaximumConcurrency: 3 },
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(1 minute)",
      State: "ENABLED",
    });
  });

  test("grants the worker valid least-privilege access to canonical repository objects", () => {
    type PolicyStatement = {
      Sid?: string;
      Effect?: string;
      Action?: string[];
      Resource?: unknown;
      Condition?: unknown;
    };
    const statements = Object.values(
      template.findResources("AWS::IAM::Role")
    ).flatMap((role) =>
      (role.Properties?.Policies ?? []).flatMap(
        (policy: { PolicyDocument?: { Statement?: PolicyStatement[] } }) =>
          policy.PolicyDocument?.Statement ?? []
      )
    );
    const repositoryAccess = statements.find(
      (statement) => statement.Sid === "CanonicalRepositoryObjectAccess"
    );

    expect(repositoryAccess).toMatchObject({
      Effect: "Allow",
      Action: [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:GetObjectTagging",
        "s3:PutObject",
      ],
    });
    expect(JSON.stringify(repositoryAccess?.Resource)).toContain(
      ":s3:::aistudio-dev-documents/repositories/*"
    );
    expect(repositoryAccess?.Condition).toBeUndefined();
  });

  test("dispatches embeddings through an exact queue ARN without tag conditions", () => {
    type PolicyStatement = {
      Sid?: string;
      Effect?: string;
      Action?: string | string[];
      Resource?: unknown;
      Condition?: unknown;
    };
    const statements = Object.values(
      template.findResources("AWS::IAM::Role")
    ).flatMap((role) =>
      (role.Properties?.Policies ?? []).flatMap(
        (policy: { PolicyDocument?: { Statement?: PolicyStatement[] } }) =>
          policy.PolicyDocument?.Statement ?? []
      )
    );
    const embeddingDispatch = statements.find(
      (statement) => statement.Sid === "CanonicalEmbeddingDispatch"
    );

    expect(embeddingDispatch).toMatchObject({
      Effect: "Allow",
      Action: "sqs:SendMessage",
    });
    expect(embeddingDispatch?.Resource).toEqual({
      "Fn::GetAtt": [expect.stringMatching(/^EmbeddingQueue/), "Arn"],
    });
    expect(JSON.stringify(embeddingDispatch?.Resource)).not.toContain("*");
    expect(embeddingDispatch?.Condition).toBeUndefined();
  });

  test("grants only the documented wildcard APIs", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const roles = template.findResources("AWS::IAM::Role");
    const wildcardActions = new Set<string>();
    type Statement = { Action?: string | string[]; Resource?: unknown };
    const statements: Statement[] = [];
    for (const resource of Object.values(policies) as Array<{
      Properties?: { PolicyDocument?: { Statement?: Statement[] } };
    }>) {
      statements.push(...(resource.Properties?.PolicyDocument?.Statement ?? []));
    }
    for (const resource of Object.values(roles) as Array<{
      Properties?: {
        Policies?: Array<{ PolicyDocument?: { Statement?: Statement[] } }>;
      };
    }>) {
      for (const policy of resource.Properties?.Policies ?? []) {
        statements.push(...(policy.PolicyDocument?.Statement ?? []));
      }
    }
    for (const statement of statements) {
        if (statement.Resource !== "*") continue;
        const actions = Array.isArray(statement.Action)
          ? statement.Action
          : [statement.Action];
        for (const action of actions) {
          if (action) wildcardActions.add(action);
        }
    }
    expect([...wildcardActions].sort()).toEqual([
      "ec2:AssignPrivateIpAddresses",
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:UnassignPrivateIpAddresses",
      "textract:GetDocumentTextDetection",
      "textract:StartDocumentTextDetection",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]);
  });

  test("grants image captioning only to US Amazon Nova resources", () => {
    type PolicyStatement = {
      Sid?: string;
      Action?: string | string[];
      Resource?: string | string[];
    };
    const statements = Object.values(
      template.findResources("AWS::IAM::Role")
    ).flatMap((role) =>
      (role.Properties?.Policies ?? []).flatMap(
        (policy: { PolicyDocument?: { Statement?: PolicyStatement[] } }) =>
          policy.PolicyDocument?.Statement ?? []
      )
    );
    const captioning = statements.find(
      (statement) => statement.Sid === "CanonicalImageCaptioning"
    );
    expect(captioning?.Action).toEqual("bedrock:InvokeModel");
    const resources = Array.isArray(captioning?.Resource)
      ? captioning.Resource
      : [captioning?.Resource];
    const resourcesJson = JSON.stringify(resources);
    expect(resourcesJson).toContain(
      ":bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-"
    );
    expect(resourcesJson).toContain(
      ":bedrock:us-west-2::foundation-model/amazon.nova-"
    );
    expect(resources).not.toContain("*");
  });
});
