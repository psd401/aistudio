import * as cdk from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import { Template } from "aws-cdk-lib/assertions"
import { EcsServiceConstruct } from "../../lib/constructs/ecs-service"

/**
 * Regression guard for issues #878 / #1009 / #1105 (FS#162359).
 *
 * Qualys WAS repeatedly flagged the ALB-injected `AWSALB` / `AWSALBCORS`
 * stickiness cookies for missing the `Secure` / `HttpOnly` attributes
 * (CWE-614 / CWE-1004). AWS provides no API to set those flags on
 * duration-based stickiness cookies, so PR #879 removed ALB stickiness
 * entirely — the app is stateless (JWT sessions), so it provided no benefit.
 * See docs/learnings/infrastructure/2026-04-08-alb-stickiness-cookie-secure-httponly-not-configurable.md
 *
 * This test asserts the synthesized ECS target group never re-enables
 * stickiness, so any future change that re-adds `stickinessCookieDuration`
 * (or `stickiness.enabled = true`) fails here instead of resurfacing the
 * scanner finding in production.
 */
describe("ECS Service — ALB stickiness regression guard (#1105)", () => {
  function synthTemplate(): Template {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, "TestStack", {
      env: { account: "123456789012", region: "us-east-1" },
    })
    const vpc = new ec2.Vpc(stack, "TestVpc", { maxAzs: 2 })

    // Complete secret ARNs (fromSecretCompleteArn requires the 6-char suffix).
    const secretArn = (name: string) =>
      `arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev-${name}-AbCdEf`

    new EcsServiceConstruct(stack, "EcsService", {
      vpc,
      environment: "dev",
      documentsBucketName: "aistudio-dev-documents",
      agentWorkspaceBucketName: "aistudio-dev-agent-workspace",
      atriumSandboxOrigin: "https://sandbox.example.com",
      // fromEcrRepository avoids a Docker asset build during synth.
      dockerImageSource: "fromEcrRepository",
      authUrl: "https://dev.aistudio.psd401.ai",
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
    })

    return Template.fromStack(stack)
  }

  test("target group is created but never enables ALB stickiness", () => {
    const template = synthTemplate()
    const targetGroups = template.findResources(
      "AWS::ElasticLoadBalancingV2::TargetGroup"
    )

    // Sanity: the construct did build a target group (otherwise the assertions
    // below would pass vacuously).
    expect(Object.keys(targetGroups).length).toBeGreaterThan(0)

    for (const resource of Object.values(targetGroups) as Record<
      string,
      unknown
    >[]) {
      const attributes: Array<{ Key?: string; Value?: unknown }> =
        (
          resource as {
            Properties?: {
              TargetGroupAttributes?: Array<{ Key?: string; Value?: unknown }>
            }
          }
        ).Properties?.TargetGroupAttributes ?? []

      const stickinessEnabled = attributes.find(
        (attr) => attr.Key === "stickiness.enabled"
      )

      // The default (disabled) state synthesizes `stickiness.enabled: "false"`;
      // the attribute may be absent instead. Both are acceptable — the
      // regression to guard against is the value flipping to "true", which is
      // what re-adding `stickinessCookieDuration` (the pre-#879 config)
      // produces and which makes AWS inject the AWSALB/AWSALBCORS cookies.
      if (stickinessEnabled !== undefined) {
        expect(String(stickinessEnabled.Value)).toBe("false")
      }

      // Belt-and-suspenders: no stickiness cookie configuration of any kind
      // should be present. Covers both duration-based (`stickiness.lb_cookie.*`,
      // the literal pre-#879 vector) and application-based (`stickiness.app_cookie.*`)
      // stickiness — either would reintroduce a scanner-flagged cookie.
      const stickinessCookieKeys = attributes
        .map((attr) => attr.Key)
        .filter(
          (key): key is string =>
            typeof key === "string" &&
            key.startsWith("stickiness.") &&
            key !== "stickiness.enabled"
        )
      expect(stickinessCookieKeys).toEqual([])
    }
  })
})
