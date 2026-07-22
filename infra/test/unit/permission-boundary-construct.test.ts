import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { PermissionBoundaryConstruct } from "../../lib/constructs/security/permission-boundary-construct";

type PolicyStatement = {
  Sid?: string;
  Action?: string | string[];
};

function allowedActions(environment: "dev" | "prod"): string[] {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, `PermissionBoundary-${environment}`, {
    env: { account: "123456789012", region: "us-east-1" },
  });
  new PermissionBoundaryConstruct(stack, "Boundary", { environment });

  const policies = Template.fromStack(stack).findResources(
    "AWS::IAM::ManagedPolicy"
  );
  const statements = Object.values(policies).flatMap((policy) =>
    (policy.Properties?.PolicyDocument?.Statement ?? []) as PolicyStatement[]
  );
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

  test("prod permits the GuardDuty verdict lookup used before processing", () => {
    expect(allowedActions("prod")).toContain("s3:GetObjectTagging");
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
      expect(actions).not.toContain("bedrock:*");
    }
  );
});
