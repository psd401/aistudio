import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { PermissionBoundaryConstruct } from "../../lib/constructs/security/permission-boundary-construct";

type PolicyStatement = {
  Sid?: string;
  Action?: string | string[];
  NotResource?: string | string[];
};

function policyStatements(environment: "dev" | "prod"): PolicyStatement[] {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, `PermissionBoundary-${environment}`, {
    env: { account: "123456789012", region: "us-east-1" },
  });
  new PermissionBoundaryConstruct(stack, "Boundary", { environment });

  const policies = Template.fromStack(stack).findResources(
    "AWS::IAM::ManagedPolicy"
  );
  return Object.values(policies).flatMap((policy) =>
    (policy.Properties?.PolicyDocument?.Statement ?? []) as PolicyStatement[]
  );
}

function allowedActions(environment: "dev" | "prod"): string[] {
  const statements = policyStatements(environment);
  const allowedServices = statements.find(
    (statement) => statement.Sid === "AllowedServices"
  );
  const actions = Array.isArray(allowedServices?.Action)
    ? allowedServices.Action
    : [allowedServices?.Action];
  return actions.filter((action): action is string => Boolean(action));
}

describe("PermissionBoundaryConstruct", () => {
  test.each(["dev", "prod"] as const)(
    "%s permits the asynchronous OCR calls used by unified content processing",
    (environment) => {
      expect(allowedActions(environment)).toEqual(
        expect.arrayContaining([
          "textract:StartDocumentTextDetection",
          "textract:GetDocumentTextDetection",
        ])
      );
    }
  );

  test("prod permits the exact S3 lifecycle operations used by canonical uploads", () => {
    expect(allowedActions("prod")).toEqual(
      expect.arrayContaining([
        "s3:GetObjectTagging",
        "s3:PutObjectTagging",
        "s3:DeleteObjectVersion",
        "s3:AbortMultipartUpload",
        "s3:ListBucketVersions",
      ])
    );
  });

  test("prod permits durable SQS delivery retries to change message visibility", () => {
    expect(allowedActions("prod")).toContain("sqs:ChangeMessageVisibility");
  });

  test("prod permits service roles to release only the two agent DynamoDB claim tables", () => {
    const statement = policyStatements("prod").find(
      (candidate) =>
        candidate.Sid === "RequireMFAForDynamoDBDeleteExceptAgentState"
    );

    expect(statement?.Action).toBe("dynamodb:DeleteItem");
    expect(statement?.NotResource).toEqual([
      "arn:aws:dynamodb:*:*:table/psd-agent-session-locks-*",
      "arn:aws:dynamodb:*:*:table/psd-agent-message-dedup-*",
    ]);
  });

  test.each(["dev", "prod"] as const)(
    "%s permits only the BDA runtime operations used by canonical media processing",
    (environment) => {
      const actions = allowedActions(environment);
      expect(actions).toEqual(
        expect.arrayContaining([
          "bedrock:InvokeDataAutomationAsync",
          "bedrock:GetDataAutomationStatus",
        ])
      );
      expect(actions).not.toContain("bedrock:TagResource");
      expect(actions).not.toContain("bedrock:*");
    }
  );
});
