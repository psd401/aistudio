import * as path from "node:path"
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
 * agent-media — container-image Lambda behind the root-owned loopback relay,
 * giving the agent HTML-to-PDF, ffmpeg transcode/probe, and Amazon Transcribe
 * (issue #1738). See infra/agent-media/README.md for the operation contract.
 *
 * Container image, not a zip: Chromium + FFmpeg blow the 250 MB zip ceiling and
 * sit comfortably under the 10 GB image limit. They cannot live in the agent
 * image at all — the AgentCore Firecracker snapshotter cannot carry that native
 * stack, and that image is near its 54-layer ceiling.
 *
 * x86_64 to match hyperframes-render and because the Debian chromium package is
 * the reliable arm64-free choice here; the platform is pinned so the image is
 * reproducible when built from an arm64 host.
 */
export interface AgentMediaFunctionProps {
  /** Deployment environment — drives tags, log retention, and IAM tag conditions. */
  environment: Environment
  /** Physical Lambda function name (e.g. `psd-agent-media-dev`). */
  functionName: string
  /** Workspace bucket holding each owner's private prefix. */
  workspaceBucket: s3.IBucket
  region: string
  account: string
  /** Lambda memory in MB. Transcode and Chromium are CPU-bound; more memory = more vCPU. */
  memorySize?: number
  /** Invoke timeout. Default 900 s (Lambda max) — a long transcription can use it. */
  timeout?: cdk.Duration
  /** /tmp size in MB for input, output and Chromium scratch. */
  ephemeralStorageMiB?: number
  /**
   * Cap on parallel jobs. Each is an expensive multi-GB container, so bound it
   * so a burst cannot drain the account's shared Lambda concurrency pool.
   */
  reservedConcurrency?: number
}

export class AgentMediaFunction extends Construct {
  public readonly function: lambda.DockerImageFunction
  public readonly logGroup: logs.LogGroup

  constructor(scope: Construct, id: string, props: AgentMediaFunctionProps) {
    super(scope, id)

    const {
      environment,
      functionName,
      workspaceBucket,
      region,
      account,
      memorySize = 4096,
      timeout = cdk.Duration.seconds(900),
      ephemeralStorageMiB = 6144,
      reservedConcurrency = 5,
    } = props

    // The function reads a caller's input and writes its output inside that
    // owner's own private workspace prefix. The prefix is not known at synth
    // time — it is whichever owner the relay verified for this invocation — so
    // the object-level grant covers the bucket, and the OWNER boundary is
    // enforced upstream: the relay injects a web-verified workspacePrefix and
    // the handler refuses any relative path that tries to escape it.
    //
    // The explicit Deny is the part worth reading twice. This function must
    // never write to public-images/, because a scanned IEP or a staff recording
    // must not become a public-by-link object. Stating that as a Deny makes it
    // an IAM property rather than a code convention, so it holds even if the
    // handler is later changed by someone who has not read why.
    //
    // Deliberately NO aws:ResourceTag condition on PutObject: an object-level
    // PutObject presents no resource tags at authorization time (the object does
    // not exist yet), so such a condition is never satisfiable and every write
    // is denied. Documented at length on the hyperframes-render construct and
    // observed live in the #1138 follow-up.
    const workspaceObjectPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: "ReadWriteOwnerWorkspaceObjects",
          effect: iam.Effect.ALLOW,
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [`${workspaceBucket.bucketArn}/*`],
        }),
        new iam.PolicyStatement({
          sid: "NeverTouchPublicArtifacts",
          effect: iam.Effect.DENY,
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [`${workspaceBucket.bucketArn}/public-images/*`],
        }),
      ],
    })

    // Transcribe scoped to the job-name prefix the handler mints
    // (`agent-media-<uuid>`), so this role cannot read or disturb transcription
    // jobs started by anything else in the account. demontek's 2026-09-03
    // failure was precisely this permission being absent
    // ("no AWS Transcribe IAM permission on the execution role").
    const transcribePolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: "RunAgentMediaTranscriptionJobs",
          effect: iam.Effect.ALLOW,
          actions: [
            "transcribe:StartTranscriptionJob",
            "transcribe:GetTranscriptionJob",
          ],
          resources: [
            `arn:aws:transcribe:${region}:${account}:transcription-job/agent-media-*`,
          ],
        }),
      ],
    })

    const role = ServiceRoleFactory.createLambdaRole(this, "Role", {
      functionName,
      environment,
      region,
      account,
      vpcEnabled: false,
      additionalPolicies: [workspaceObjectPolicy, transcribePolicy],
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

    // The handler imports ../validated-fs.cjs from /var/task, so the build
    // context must include the canonical infra/validated-fs.cjs beside
    // agent-media/. Keep the context narrow: without these exclusions every
    // unrelated infra change would rebuild a 2 GB image and CDK would stage
    // infra/node_modules.
    const imageAssetRoot = path.join(__dirname, "..", "..", "..")
    this.function = new lambda.DockerImageFunction(this, "Function", {
      functionName,
      description: `Agent media: HTML-to-PDF, ffmpeg, Transcribe (#1738) — ${environment}`,
      code: lambda.DockerImageCode.fromImageAsset(imageAssetRoot, {
        file: "agent-media/Dockerfile",
        exclude: [
          "**",
          "!validated-fs.cjs",
          "!agent-media/",
          "!agent-media/Dockerfile",
          "!agent-media/entrypoint.sh",
          "!agent-media/handler.js",
          "!agent-media/package.json",
          // Docker-ignore negations re-include siblings when their parent is
          // traversed. Exclude non-build inputs again so docs and tests do not
          // churn the multi-gigabyte Lambda asset hash.
          "agent-media/.gitignore",
          "agent-media/README.md",
          "agent-media/handler.test.js",
          "agent-media/node_modules",
        ],
        ignoreMode: cdk.IgnoreMode.DOCKER,
        platform: Platform.LINUX_AMD64,
      }),
      architecture: lambda.Architecture.X86_64,
      role,
      memorySize,
      timeout,
      reservedConcurrentExecutions: reservedConcurrency,
      ephemeralStorageSize: cdk.Size.mebibytes(ephemeralStorageMiB),
      logGroup: this.logGroup,
      environment: {
        WORKSPACE_BUCKET: workspaceBucket.bucketName,
        // Leave headroom under the Lambda timeout so a stuck transcode or
        // transcription returns a clean, attributable error instead of being
        // cut off mid-flight by the platform, which surfaces to the agent as an
        // opaque invoke failure with nothing to tell the user.
        MEDIA_FFMPEG_TIMEOUT_MS: String(
          Math.max(timeout.toMilliseconds() - 180_000, 60_000),
        ),
        MEDIA_TRANSCRIBE_TIMEOUT_MS: String(
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
