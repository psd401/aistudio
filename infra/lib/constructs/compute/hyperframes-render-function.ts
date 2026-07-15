import * as path from "path"
import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda"
import * as iam from "aws-cdk-lib/aws-iam"
import * as logs from "aws-cdk-lib/aws-logs"
import * as s3 from "aws-cdk-lib/aws-s3"
import { Platform } from "aws-cdk-lib/aws-ecr-assets"
import { Construct } from "constructs"
import { ServiceRoleFactory } from "../security"
import { Environment } from "../security/types"

/**
 * hyperframes-render — a container-image Lambda that renders a HyperFrames
 * HTML/CSS/JS composition to MP4 (headless Chromium + FFmpeg) and uploads the
 * result to the workspace S3 bucket's public `public-images/` prefix. Render
 * half of the psd-hyperframes agent skill (issue #1175).
 *
 * Container image (not a zip): the Chromium + FFmpeg + hyperframes stack blows
 * the 250 MB zip ceiling but sits comfortably under the 10 GB image limit. The
 * image is built from infra/hyperframes-render/Dockerfile (a port of upstream
 * heygen-com/hyperframes' Dockerfile.render). Chromium/FFmpeg live ONLY here —
 * never in the agent image, whose AgentCore Firecracker snapshotter cannot
 * carry that native stack.
 *
 * The image is x86_64 (chrome-for-testing ships a linux64 headless-shell but no
 * arm64 build), so the platform is pinned to LINUX_AMD64 for reproducible
 * cross-arch builds from an arm64 host.
 */
export interface HyperframesRenderFunctionProps {
  /** Deployment environment — drives tags, log retention, and IAM tag conditions. */
  environment: Environment
  /** Physical Lambda function name (e.g. `psd-hyperframes-render-dev`). */
  functionName: string
  /** Workspace bucket the rendered MP4 is written to (public-images/ prefix). */
  workspaceBucket: s3.IBucket
  region: string
  account: string
  /** Lambda memory in MB. Render is CPU-bound; more memory = more vCPU. Default 4096. */
  memorySize?: number
  /** Invoke timeout. Default 900 s (Lambda max) for the longest capped scenes. */
  timeout?: cdk.Duration
  /** /tmp size in MB for frame + MP4 scratch. Default 4096. */
  ephemeralStorageMiB?: number
  /**
   * Cap on parallel renders (reservedConcurrentExecutions). Each render is an
   * expensive 4 GB / multi-minute Chromium+FFmpeg container, so cap it so an
   * agent-render burst can't drain the account's shared Lambda concurrency
   * pool. Default 5.
   */
  reservedConcurrency?: number
}

export class HyperframesRenderFunction extends Construct {
  public readonly function: lambda.DockerImageFunction
  public readonly logGroup: logs.LogGroup

  constructor(scope: Construct, id: string, props: HyperframesRenderFunctionProps) {
    super(scope, id)

    const {
      environment,
      functionName,
      workspaceBucket,
      region,
      account,
      memorySize = 4096,
      timeout = cdk.Duration.seconds(900),
      ephemeralStorageMiB = 4096,
      reservedConcurrency = 5,
    } = props

    // Least-privilege S3 write, scoped to the public-images/ prefix only — the
    // render service never reads, lists, or deletes, and never touches other
    // prefixes. Tag conditions mirror ServiceRoleFactory.buildS3AccessPolicy so
    // a dev function can only write a dev-tagged bucket.
    const s3WritePolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: "WriteRenderedVideoToPublicImages",
          effect: iam.Effect.ALLOW,
          actions: ["s3:PutObject"],
          resources: [`${workspaceBucket.bucketArn}/public-images/*`],
          conditions: {
            StringEquals: {
              "aws:ResourceTag/Environment": environment,
              "aws:ResourceTag/ManagedBy": "cdk",
            },
          },
        }),
      ],
    })

    const role = ServiceRoleFactory.createLambdaRole(this, "Role", {
      functionName,
      environment,
      region,
      account,
      vpcEnabled: false,
      additionalPolicies: [s3WritePolicy],
    })

    // Explicit, retention-managed log group named to match the function so the
    // ServiceRoleFactory base policy's `/aws/lambda/${functionName}` grant lines
    // up and Lambda does not auto-create an unmanaged group.
    this.logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/aws/lambda/${functionName}`,
      retention:
        environment === "prod" ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    this.function = new lambda.DockerImageFunction(this, "Function", {
      functionName,
      description: `Renders a HyperFrames HTML/CSS/JS composition to MP4 (#1175) — ${environment}`,
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, "..", "..", "..", "hyperframes-render"),
        { platform: Platform.LINUX_AMD64 },
      ),
      architecture: lambda.Architecture.X86_64,
      role,
      memorySize,
      timeout,
      reservedConcurrentExecutions: reservedConcurrency,
      ephemeralStorageSize: cdk.Size.mebibytes(ephemeralStorageMiB),
      logGroup: this.logGroup,
      environment: {
        WORKSPACE_BUCKET: workspaceBucket.bucketName,
        // Give the in-handler render timeout 180 s of headroom under the Lambda
        // timeout so a stuck render returns a clean `render_timeout` well before
        // the enclosing agent-turn transport budget (~840 s, whose clock starts
        // earlier) aborts the call and orphans the render.
        HYPERFRAMES_RENDER_TIMEOUT_MS: String(
          Math.max(timeout.toMilliseconds() - 180_000, 60_000),
        ),
      },
    })

    cdk.Tags.of(this.function).add("Environment", environment)
    cdk.Tags.of(this.function).add("ManagedBy", "cdk")
    cdk.Tags.of(this.logGroup).add("Environment", environment)
    cdk.Tags.of(this.logGroup).add("ManagedBy", "cdk")
  }
}
