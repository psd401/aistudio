import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { DocumentProcessingStack } from "../../lib/document-processing-stack";

describe("legacy document processor packaging", () => {
  it("bundles both processors from TypeScript with an index.handler entrypoint", () => {
    const app = new cdk.App();
    const stack = new DocumentProcessingStack(app, "DocumentPackagingTest", {
      env: { account: "123456789012", region: "us-east-1" },
      environment: "dev",
      rdsClusterArn:
        "arn:aws:rds:us-east-1:123456789012:cluster:aistudio-dev",
      rdsSecretArn:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev",
      documentsBucketName: "aistudio-dev-documents",
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "AIStudio-DocumentProcessor-Standard-dev",
      Runtime: "nodejs20.x",
      Handler: "index.handler",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "AIStudio-DocumentProcessor-HighMemory-dev",
      Runtime: "nodejs20.x",
      Handler: "index.handler",
    });
  });
});
