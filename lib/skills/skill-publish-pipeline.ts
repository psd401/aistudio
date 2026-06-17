/**
 * Skill publish pipeline helpers (Issue #925).
 *
 * Bridges the web app to the existing infra-side skill scan pipeline:
 *   1. Upload the serialized SKILL.md folder to the agent workspace S3 bucket
 *      under the same `skills/user/{email}/drafts/{slug}/` prefix the
 *      psd-skills-meta `author` command uses (infra/.../common.js).
 *   2. (Best-effort) invoke the `agent-skill-builder` Lambda to scan + promote.
 *
 * The web app writes the `psd_agent_skills` row directly via Drizzle (it has a
 * direct postgres.js connection), so the Lambda invoke is purely the scan +
 * S3 promotion step. If the Lambda ARN is not wired into the ECS task, the
 * invoke is skipped and the skill remains a `draft`/`pending` row that an admin
 * can review — matching the non-fatal behaviour of the infra-side author flow.
 */

import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3"
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"
import { createLogger } from "@/lib/logger"

const log = createLogger({ service: "skill-publish-pipeline" })

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1"
const ENVIRONMENT = process.env.ENVIRONMENT || process.env.NODE_ENV || "dev"

/**
 * Resolve the agent workspace bucket name. Wired into the ECS task as
 * AGENT_WORKSPACE_BUCKET (mirrors infra SSM /aistudio/{env}/agent-workspace-bucket-name).
 */
export function getSkillsBucket(): string | null {
  return (
    process.env.AGENT_WORKSPACE_BUCKET ||
    process.env.WORKSPACE_BUCKET ||
    null
  )
}

/** Resolve the skill-builder Lambda ARN if it has been provisioned to ECS. */
export function getSkillBuilderLambdaArn(): string | null {
  return process.env.SKILL_BUILDER_LAMBDA_ARN || null
}

export interface SkillFile {
  /** Relative path within the skill folder, e.g. "SKILL.md". */
  path: string
  /** UTF-8 text content. */
  content: string
  contentType?: string
}

export interface UploadSkillParams {
  ownerEmail: string
  slug: string
  files: SkillFile[]
}

export interface UploadSkillResult {
  /** S3 key prefix where the draft skill folder was written. */
  draftPrefix: string
  /** Where the scan pipeline would promote a clean skill. */
  destinationPrefix: string
}

/** RFC-lite email check (mirrors infra common.js validateUserEmail). */
const EMAIL_RE = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/
/** S3/path-safe slug check (mirrors infra common.js SAFE_NAME_RE). */
const SAFE_SLUG_RE = /^[a-zA-Z0-9_.-]+$/

/**
 * Validate the components that flow into the S3 key. Both are validated again
 * here (defense in depth) even though the serializer produces a safe slug and
 * the email comes from the authenticated session — neither must ever be able
 * to inject "/" or ".." into the object key.
 */
function assertSafeKeyParts(ownerEmail: string, slug: string): void {
  if (!EMAIL_RE.test(ownerEmail) || ownerEmail.includes("..")) {
    throw new Error(`Invalid owner email for skill S3 key: "${ownerEmail}"`)
  }
  if (!SAFE_SLUG_RE.test(slug) || slug.includes("..")) {
    throw new Error(`Invalid skill slug for S3 key: "${slug}"`)
  }
}

let s3ClientSingleton: S3Client | null = null
function getS3(): S3Client {
  if (!s3ClientSingleton) {
    s3ClientSingleton = new S3Client({ region: REGION })
  }
  return s3ClientSingleton
}

/**
 * Upload a serialized skill folder to the draft prefix in the workspace bucket.
 * Tags objects identically to the infra author flow so existing lifecycle and
 * tag-based IAM rules apply.
 *
 * @throws Error if the bucket is not configured.
 */
export async function uploadSkillDraft(
  params: UploadSkillParams
): Promise<UploadSkillResult> {
  const bucket = getSkillsBucket()
  if (!bucket) {
    throw new Error(
      "Agent workspace bucket is not configured (AGENT_WORKSPACE_BUCKET). " +
        "Cannot publish skill to S3."
    )
  }

  const { ownerEmail, slug, files } = params
  assertSafeKeyParts(ownerEmail, slug)
  const draftPrefix = `skills/user/${ownerEmail}/drafts/${slug}`
  const destinationPrefix = `skills/user/${ownerEmail}/approved/${slug}`
  const tagging = `Environment=${ENVIRONMENT}&ManagedBy=cdk&Scope=draft&Owner=${encodeURIComponent(
    ownerEmail
  )}`

  const s3 = getS3()
  for (const file of files) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${draftPrefix}/${file.path}`,
        Body: file.content,
        ContentType: file.contentType ?? "text/markdown",
        Tagging: tagging,
      })
    )
  }

  log.info("Uploaded skill draft to S3", {
    bucket,
    draftPrefix,
    fileCount: files.length,
  })

  return { draftPrefix, destinationPrefix }
}

export interface InvokeScanParams {
  skillId: string
  draftPrefix: string
  destinationPrefix: string
}

/**
 * Best-effort invocation of the skill-builder Lambda for scanning + promotion.
 * Returns true if the invoke was dispatched, false if skipped (no ARN) or it
 * failed. Never throws — a failed scan-invoke leaves the skill as a pending
 * draft that an admin can review/retry, exactly like the infra author flow.
 */
export async function invokeSkillScan(
  params: InvokeScanParams
): Promise<boolean> {
  const arn = getSkillBuilderLambdaArn()
  if (!arn) {
    log.info("Skill-builder Lambda ARN not configured; skill stays as pending draft", {
      skillId: params.skillId,
    })
    return false
  }

  try {
    const client = new LambdaClient({ region: REGION })
    await client.send(
      new InvokeCommand({
        FunctionName: arn,
        InvocationType: "Event", // async — do not block the request
        Payload: Buffer.from(
          JSON.stringify({
            skillId: params.skillId,
            s3Key: params.draftPrefix,
            destinationPrefix: params.destinationPrefix,
            scope: "user",
            ownerUserId: null, // resolved in the Lambda from the DB
          })
        ),
      })
    )
    log.info("Dispatched skill-builder scan", { skillId: params.skillId })
    return true
  } catch (error) {
    log.error("Skill-builder invoke failed (non-fatal)", {
      skillId: params.skillId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
