import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { DocumentProcessingStack } from "../../lib/document-processing-stack";
import { ProcessingStack } from "../../lib/processing-stack";

interface CloudFormationResource {
  Condition?: string;
  Properties?: Record<string, unknown>;
  Type?: string;
}

function synthesizeDocumentRetirementTemplate(): Record<string, unknown> {
  const app = new cdk.App({
    context: { retireLegacyContent: "true" },
  });
  const stack = new DocumentProcessingStack(
    app,
    "DocumentProcessingRetirementTest",
    {
      env: { account: "123456789012", region: "us-east-1" },
      environment: "dev",
      rdsClusterArn: "arn:aws:rds:us-east-1:123456789012:cluster:aistudio-dev",
      rdsSecretArn:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev",
      documentsBucketName: "aistudio-dev-documents",
    },
  );
  return Template.fromStack(stack).toJSON() as Record<string, unknown>;
}

function synthesizeRetirementTemplate(): Record<string, unknown> {
  const app = new cdk.App({
    context: { retireLegacyContent: "true" },
  });
  const stack = new ProcessingStack(app, "ProcessingRetirementTest", {
    env: { account: "123456789012", region: "us-east-1" },
    environment: "dev",
    documentsBucketName: "aistudio-dev-documents",
    databaseResourceArn:
      "arn:aws:rds:us-east-1:123456789012:cluster:aistudio-dev",
    databaseSecretArn:
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev",
    googleContentOAuthSecretArn:
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio/dev/google-content-oauth-AbCdEf",
  });
  return Template.fromStack(stack).toJSON() as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

describe("legacy content infrastructure retirement", () => {
  const template = synthesizeRetirementTemplate();
  const resourceEntries = Object.entries(record(template.Resources)) as Array<
    [string, CloudFormationResource]
  >;
  const resources = resourceEntries.map(([, resource]) => resource);
  const outputs = Object.values(record(template.Outputs)) as Array<{
    Condition?: string;
    Export?: unknown;
  }>;

  it("conditions every legacy processor and queue out of the retirement template", () => {
    const legacyResources = resourceEntries.filter(([logicalId]) =>
      /(JobStatusTable|FileProcessing|FileProcessor|URLProcessor|TextractCompletion|TextractService|TextractProcessor)/.test(
        logicalId,
      ),
    );
    expect(legacyResources.length).toBeGreaterThan(10);
    expect(
      legacyResources.every(
        ([, resource]) => resource.Condition === "RetainLegacyContent",
      ),
    ).toBe(true);
    expect(record(template.Conditions).RetainLegacyContent).toEqual({
      "Fn::Equals": ["retired", "retained"],
    });
  });

  it("removes legacy exports while retaining canonical processing resources", () => {
    const legacyExports = outputs.filter((output) =>
      JSON.stringify(output.Export).match(
        /(FileProcessing|JobStatus|FileProcessor|URLProcessor|Textract)/,
      ),
    );
    expect(legacyExports.length).toBeGreaterThan(0);
    expect(
      legacyExports.every(
        (output) => output.Condition === "RetainLegacyContent",
      ),
    ).toBe(true);

    const canonicalWorker = resources.find((resource) =>
      JSON.stringify(resource.Properties).includes(
        "aistudio-dev-unified-content-processor",
      ),
    );
    expect(canonicalWorker).toBeDefined();
    expect(canonicalWorker?.Condition).toBeUndefined();
    expect(JSON.stringify(template.Resources)).not.toContain(
      "LegacyContentMigrationRead",
    );
    expect(JSON.stringify(template.Resources)).not.toContain(
      "LegacyContentMigrationDiscovery",
    );
  });

  it("keeps the document stack deployable while removing every v2 legacy resource", () => {
    const documentTemplate = synthesizeDocumentRetirementTemplate();
    const documentResources = Object.values(
      record(documentTemplate.Resources),
    ) as CloudFormationResource[];
    const documentOutputs = Object.values(
      record(documentTemplate.Outputs),
    ) as Array<{ Condition?: string }>;

    expect(documentResources.length).toBeGreaterThan(10);
    expect(
      documentResources.every(
        (resource) => resource.Condition === "RetainLegacyDocumentProcessing",
      ),
    ).toBe(true);
    expect(
      documentOutputs.every(
        (output) => output.Condition === "RetainLegacyDocumentProcessing",
      ),
    ).toBe(true);
    expect(
      record(documentTemplate.Conditions).RetainLegacyDocumentProcessing,
    ).toEqual({
      "Fn::Equals": ["retired", "retained"],
    });
  });
});
