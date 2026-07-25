import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AuthStack } from "../../lib/auth-stack";

function synthesize(): Template {
  const app = new cdk.App();
  const stack = new AuthStack(app, "GoogleContentOAuthTest", {
    environment: "dev",
    googleClientSecret: cdk.SecretValue.secretsManager(
      "aistudio-dev-google-oauth",
      { jsonField: "clientSecret" },
    ),
    callbackUrls: ["https://dev.example.test/api/auth/callback/cognito"],
    logoutUrls: ["https://dev.example.test"],
    env: { account: "123456789012", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

describe("Google content OAuth deployment contract", () => {
  const template = synthesize();

  test("requires the browser-restricted Picker key as a deployment parameter", () => {
    template.hasParameter("GooglePickerApiKey", {
      Type: "String",
      NoEcho: true,
      MinLength: 1,
    });
  });

  test("creates and retains the complete runtime configuration secret", () => {
    const resources = template.findResources("AWS::SecretsManager::Secret", {
      Properties: {
        Name: "aistudio/dev/google-content-oauth",
      },
    });
    expect(Object.keys(resources)).toHaveLength(1);
    const [logicalId, resource] = Object.entries(resources)[0] ?? [];
    expect(logicalId).toBeDefined();
    expect(resource).toBeDefined();
    expect(resource?.DeletionPolicy).toBe("Retain");
    expect(resource?.UpdateReplacePolicy).toBe("Retain");

    const secretString = JSON.stringify(resource?.Properties?.SecretString);
    for (const field of ["clientId", "clientSecret", "pickerApiKey", "appId"]) {
      expect(secretString).toContain(`\\"${field}\\"`);
    }
    expect(secretString).toContain("GoogleClientId");
    expect(secretString).toContain("GooglePickerApiKey");
    expect(secretString).toContain("aistudio-dev-google-oauth");
    expect(secretString).toContain("clientSecret");
    expect(secretString).toContain("Fn::Split");
  });
});
