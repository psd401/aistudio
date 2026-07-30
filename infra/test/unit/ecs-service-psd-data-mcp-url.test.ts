import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Match, Template } from "aws-cdk-lib/assertions";
import { DEFAULT_PSD_DATA_MCP_URL } from "../../lib/agent-endpoints";
import { EcsServiceConstruct } from "../../lib/constructs/ecs-service";

type Environment = "dev" | "prod";

function createTemplate(
  environment: Environment,
  context: Record<string, string> = {},
): Template {
  const app = new cdk.App({ context });
  const stack = new cdk.Stack(app, `TestStack-${environment}`, {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const vpc = new ec2.Vpc(stack, "TestVpc", { maxAzs: 2 });
  const secretArn = (name: string) =>
    `arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-${environment}-${name}-AbCdEf`;

  new EcsServiceConstruct(stack, "EcsService", {
    vpc,
    environment,
    documentsBucketName: `aistudio-${environment}-documents`,
    agentWorkspaceBucketName: `aistudio-${environment}-agent-workspace`,
    atriumSandboxOrigin: "https://sandbox.example.com",
    dockerImageSource: "fromEcrRepository",
    authUrl: `https://${environment}.aistudio.psd401.ai`,
    cognitoClientId: "test-client-id",
    cognitoIssuer:
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool",
    rdsResourceArn:
      `arn:aws:rds:us-east-1:123456789012:cluster:aistudio-${environment}-cluster`,
    rdsSecretArn: secretArn("db"),
    authSecretArn: secretArn("auth"),
    collabJwtSecretArn: secretArn("collab-jwt"),
    guardrailHashSecretArn: secretArn("guardrail-hash"),
    oidcCookieSecretArn: secretArn("oidc-cookie"),
    oidcSigningJwksSecretArn: secretArn("oidc-signing"),
  });

  return Template.fromStack(stack);
}

function expectPsdDataMcpUrl(template: Template, expectedUrl: string): void {
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Environment: Match.arrayWith([
          {
            Name: "PSD_DATA_MCP_URL",
            Value: expectedUrl,
          },
        ]),
      }),
    ]),
  });
}

describe("ECS Service — PSD data MCP URL", () => {
  it.each<Environment>(["dev", "prod"])(
    "injects the shared default into the %s frontend task",
    (environment) => {
      expectPsdDataMcpUrl(
        createTemplate(environment),
        DEFAULT_PSD_DATA_MCP_URL,
      );
    },
  );

  it("honors the psdDataMcpUrl context override", () => {
    const overrideUrl = "https://data.example.test/mcp";

    expectPsdDataMcpUrl(
      createTemplate("dev", { psdDataMcpUrl: overrideUrl }),
      overrideUrl,
    );
  });
});
