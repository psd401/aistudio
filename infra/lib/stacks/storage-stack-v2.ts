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

  // Superseded/deleted object versions are purged after this window. Deliberately a
  // dedicated constant, NOT database.backupRetention (a DB backup window) — REV-COR-486.
  private static readonly NONCURRENT_VERSION_RETENTION = cdk.Duration.days(30)

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
          id: "AtriumPendingAssetCleanup",
          enabled: true,
          prefix: "atrium/pending-assets/",
          expiration: cdk.Duration.days(1),
        },
        {
          // Reap ONLY noncurrent (superseded/deleted) versions. Do NOT set `expiration`
          // on this versioned bucket — it adds a delete marker to every live object,
          // silently 404-ing current data once it ages out (REV-COR-486). Retention is
          // an explicit, purpose-named value, not the DB backup window.
          id: "ExpireNoncurrentVersions",
          enabled: true,
          noncurrentVersionExpiration: StorageStackV2.NONCURRENT_VERSION_RETENTION,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
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
