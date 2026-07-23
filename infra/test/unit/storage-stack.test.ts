import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { StorageStack } from "../../lib/storage-stack";

describe("StorageStack repository lifecycle", () => {
  test("bounds abandoned multipart state and noncurrent repository versions", () => {
    const app = new cdk.App();
    const stack = new StorageStack(app, "StorageLifecycleTest", {
      environment: "dev",
      env: { account: "123456789012", region: "us-east-1" },
    });
    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: "RepositoryUploadAndVersionCleanup",
            Status: "Enabled",
            Prefix: "repositories/",
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            NoncurrentVersionExpiration: { NoncurrentDays: 1 },
            ExpiredObjectDeleteMarker: true,
          }),
          Match.objectLike({
            Id: "RepositoryTemporaryUploadCleanup",
            Status: "Enabled",
            ExpirationInDays: 1,
            Prefix: "repositories/",
            TagFilters: [
              {
                Key: "aistudio-upload-state",
                Value: "temporary",
              },
            ],
          }),
        ]),
      },
    });
  });
});
