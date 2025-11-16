import * as s3 from "aws-cdk-lib/aws-s3"
import * as cdk from "aws-cdk-lib"
import { BaseStack, BaseStackProps } from "../constructs/base/base-stack"

export interface StorageStackV2Props extends BaseStackProps {
  /**
   * Allowed CORS origins for the documents bucket.
   * If not provided, defaults to localhost:3000 for development only.
   * For production deployments, you should provide the actual domains.
   *
   * @example
   * // Development
   * allowedOrigins: ["https://dev.example.com", "http://localhost:3000"]
   *
   * // Production
   * allowedOrigins: ["https://example.com"]
   */
  allowedOrigins?: string[]
}

export class StorageStackV2 extends BaseStack {
  private _documentsBucketName: string = ""

  public get documentsBucketName(): string {
    return this._documentsBucketName
  }

  protected defineResources(props: StorageStackV2Props): void {
    // Determine allowed CORS origins
    const allowedOrigins = props.allowedOrigins || [
      // Default to localhost only for development
      "http://localhost:3000",
    ]

    // S3 bucket for document storage
    const bucket = new s3.Bucket(this, "DocumentsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: this.getRemovalPolicy(),
      autoDeleteObjects: this.deploymentEnvironment !== "prod",
      lifecycleRules: [
        {
          id: "ExpireDeletedObjects",
          enabled: true,
          expiration: this.config.database.backupRetention, // Use config for consistency
          noncurrentVersionExpiration: this.config.database.backupRetention,
        },
      ],
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins,
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3000,
        },
      ],
    })

    // Store bucket name for use by other stacks
    this._documentsBucketName = bucket.bucketName

    // Use BaseStack's createParameter helper for consistency
    this.createParameter(
      "documents-bucket-name",
      bucket.bucketName,
      "S3 bucket name for document storage"
    )

    // Keep CloudFormation output for backward compatibility and monitoring
    new cdk.CfnOutput(this, "DocumentsBucketName", {
      value: bucket.bucketName,
      description: "S3 bucket for document storage",
      exportName: `${this.deploymentEnvironment}-DocumentsBucketName`,
    })
  }
}
