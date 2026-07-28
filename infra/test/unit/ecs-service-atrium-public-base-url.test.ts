import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Match, Template } from "aws-cdk-lib/assertions";
import { EcsServiceConstruct } from "../../lib/constructs/ecs-service";

describe("ECS Service — Atrium public base URL", () => {
  it("injects the canonical app origin into the frontend task", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const vpc = new ec2.Vpc(stack, "TestVpc", { maxAzs: 2 });
    const secretArn = (name: string) =>
      `arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev-${name}-AbCdEf`;
    const appOrigin = "https://dev.aistudio.psd401.ai";

    new EcsServiceConstruct(stack, "EcsService", {
      vpc,
      environment: "dev",
      documentsBucketName: "aistudio-dev-documents",
      agentWorkspaceBucketName: "aistudio-dev-agent-workspace",
      atriumSandboxOrigin: "https://sandbox.example.com",
      dockerImageSource: "fromEcrRepository",
      authUrl: appOrigin,
      cognitoClientId: "test-client-id",
      cognitoIssuer:
        "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool",
      rdsResourceArn:
        "arn:aws:rds:us-east-1:123456789012:cluster:aistudio-dev-cluster",
      rdsSecretArn: secretArn("db"),
      authSecretArn: secretArn("auth"),
      collabJwtSecretArn: secretArn("collab-jwt"),
      guardrailHashSecretArn: secretArn("guardrail-hash"),
      oidcCookieSecretArn: secretArn("oidc-cookie"),
      oidcSigningJwksSecretArn: secretArn("oidc-signing"),
    });

    Template.fromStack(stack).hasResourceProperties(
      "AWS::ECS::TaskDefinition",
      {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([
              {
                Name: "ATRIUM_PUBLIC_BASE_URL",
                Value: appOrigin,
              },
            ]),
          }),
        ]),
      }
    );
  });
});
