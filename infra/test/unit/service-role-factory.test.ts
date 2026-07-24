import * as cdk from "aws-cdk-lib"
import { Template } from "aws-cdk-lib/assertions"
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager"
import { ServiceRoleFactory } from "../../lib/constructs/security/service-role-factory"

function synthesizeRole(secretReference: string): string {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, "ServiceRoleFactoryTest", {
    env: { account: "123456789012", region: "us-east-1" },
  })

  ServiceRoleFactory.createLambdaRole(stack, "TestRole", {
    functionName: "service-role-factory-test",
    environment: "dev",
    region: "us-east-1",
    account: "123456789012",
    secrets: [secretReference],
    enablePermissionBoundary: false,
  })

  const roles = Template.fromStack(stack).findResources("AWS::IAM::Role")
  return JSON.stringify(Object.values(roles))
}

describe("ServiceRoleFactory Secrets Manager resources", () => {
  it("preserves an unresolved secret ARN token as the exact policy resource", () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, "TokenSecretRoleTest", {
      env: { account: "123456789012", region: "us-east-1" },
    })
    const secret = new secretsmanager.Secret(stack, "SigningSecret")

    ServiceRoleFactory.createLambdaRole(stack, "TestRole", {
      functionName: "token-secret-role-test",
      environment: "dev",
      region: "us-east-1",
      account: "123456789012",
      secrets: [secret.secretArn],
      enablePermissionBoundary: false,
    })

    const roles = Template.fromStack(stack).findResources("AWS::IAM::Role")
    const serialized = JSON.stringify(Object.values(roles))

    expect(serialized).toContain(
      '"Action":"secretsmanager:GetSecretValue"'
    )
    expect(serialized).toMatch(
      /"Resource":\{"Ref":"SigningSecret[A-F0-9]+"\}/
    )
    expect(serialized).not.toContain('"Fn::Join"')
  })

  it("preserves a literal complete secret ARN", () => {
    const secretArn =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev-known-AbCdEf"
    const serialized = synthesizeRole(secretArn)

    expect(serialized).toContain(`"Resource":"${secretArn}"`)
    expect(serialized).not.toContain(`"Resource":"${secretArn}*"`)
  })

  it("expands a literal secret name to include the generated ARN suffix", () => {
    const serialized = synthesizeRole("aistudio-dev-known")

    expect(serialized).toContain(
      '"Resource":"arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev-known*"'
    )
  })
})
