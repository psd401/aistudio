import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import {
  and,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  sql,
  sum,
} from "drizzle-orm"
import {
  executeQuery,
  executeTransaction,
  toPgRows,
  withUnretriedDatabaseSession,
  type DrizzleDB,
  type UnretriedDatabaseSession,
} from "@/lib/db/drizzle-client"
import { workspaceUploadReservations } from "@/lib/db/schema"
import {
  acquireResourceAdmission,
  finishResourceAdmission,
  isCapacityDenial,
  releaseResourceAdmission,
} from "@/lib/resource-admission"
import { createLogger } from "@/lib/logger"
import { getSecretString } from "@/lib/agent-workspace/secrets-manager"
import {
  isCheckpointManagedWorkspacePath,
  validateWorkspaceRelativePath,
  workspaceRelativePathRejectionReason,
} from "@/lib/agent-workspace/path-policy"
import {
  MAX_RETIRED_EXEC_APPROVALS_BYTES,
  RETIRED_EXEC_APPROVALS_CLAIM_PATH,
  RETIRED_EXEC_APPROVALS_SOURCE_PATH,
  validateRetiredExecApprovalsPath,
  validateRetiredExecApprovalsRead,
} from "@/lib/agent-workspace/retired-exec-approvals"

export { validateWorkspaceRelativePath } from "@/lib/agent-workspace/path-policy"

const log = createLogger({ module: "workspace-storage-broker" })

const MAX_LIST_KEYS = 1_000
export const MAX_PRIVATE_UPLOAD_BYTES = 256 * 1024 * 1024
export const MAX_PUBLIC_ARTIFACT_BYTES = 100 * 1024 * 1024
const MAX_PRIVATE_RETAINED_BYTES = 4 * 1024 * 1024 * 1024
const MAX_PUBLIC_RETAINED_BYTES = 1024 * 1024 * 1024
const MAX_PRIVATE_RETAINED_OBJECTS = 10_000
const MAX_PUBLIC_RETAINED_OBJECTS = 1_000
const UPLOAD_RESERVATION_MS = 5 * 60 * 1000
const SHA256_BASE64_RE = /^[A-Za-z0-9+/]{43}=$/
const WORKSPACE_GENERATION_RE = /^[0-9a-f]{64}$/
const WORKSPACE_RESERVATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_WORKSPACE_GENERATION_OBJECTS = 250_000
const WORKSPACE_CHECKPOINT_VERSION = 2 as const
const WORKSPACE_CHECKPOINT_CONTROL_PREFIX = ".workspace-checkpoints/v2"
const LEGACY_WORKSPACE_CHECKPOINT_CONTROL_PREFIX = ".workspace-checkpoints/v1"
const MAX_WORKSPACE_CHECKPOINT_BYTES = 64 * 1024 * 1024
const WORKSPACE_CHECKPOINT_CONCURRENCY = 32
// Keep the inline checkpoint snapshot comfortably below API Gateway/Lambda
// response limits. Large workspaces retain the legacy generation-only
// response and the agent image falls back to the paginated list operation.
const MAX_INLINE_WORKSPACE_CHECKPOINT_SNAPSHOT_BYTES = 512 * 1024
const WORKSPACE_FINALIZATION_PROOF_VERSION = "v1"
const MAX_WORKSPACE_FINALIZATION_PROOF_BYTES = 4 * 1024
// The prepared replay record contains the next checkpoint manifest plus the
// bounded mutation result. Keep a hard cap even though both source payloads
// are independently bounded, so a corrupt control object can never force an
// unbounded read into the web tier.
const MAX_WORKSPACE_FINALIZATION_JOURNAL_BYTES =
  MAX_WORKSPACE_CHECKPOINT_BYTES * 2
// These paths were checkpoint-managed before they were identified as
// generated OpenClaw host state. Every current or manifest-bound source is
// content-validated below before exclusion; a policy or interrupted claim
// fails closed. Existing v2 manifests remain readable only long enough to
// retire verified socket-only entries without touching the owner object.
const RETIRED_WORKSPACE_CHECKPOINT_PATHS = new Set([
  RETIRED_EXEC_APPROVALS_SOURCE_PATH,
  RETIRED_EXEC_APPROVALS_CLAIM_PATH,
])
const CONTENT_TYPE_RE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i
// S3 expires a public current version after 30 days, then its resulting
// noncurrent version after 7 more. Reconcile only after a two-day safety
// margin, and only after an exact-version HEAD proves lifecycle deletion.
export const PUBLIC_LEDGER_RECONCILIATION_DAYS = 39
const RETAINED_UPLOAD_STATUSES = [
  "reserved",
  "verifying",
  "committed",
] as const

export function workspaceRetainedQuotaReason(
  currentBytes: number,
  currentObjects: number,
  additionalBytes: number,
  publicArtifact: boolean,
): "retained_bytes" | "retained_objects" | null {
  const byteLimit = publicArtifact
    ? MAX_PUBLIC_RETAINED_BYTES
    : MAX_PRIVATE_RETAINED_BYTES
  const objectLimit = publicArtifact
    ? MAX_PUBLIC_RETAINED_OBJECTS
    : MAX_PRIVATE_RETAINED_OBJECTS
  if (currentBytes + additionalBytes > byteLimit) return "retained_bytes"
  if (currentObjects + 1 > objectLimit) return "retained_objects"
  return null
}

export function workspaceReservationExpiresByLease(
  status: typeof workspaceUploadReservations.$inferSelect.status,
): boolean {
  return status === "reserved"
}

export function workspaceReservationCountsAsRetained(
  status: typeof workspaceUploadReservations.$inferSelect.status,
): boolean {
  return RETAINED_UPLOAD_STATUSES.includes(
    status as (typeof RETAINED_UPLOAD_STATUSES)[number],
  )
}
const SAFE_PUBLIC_ARTIFACT_NAME = /^[A-Za-z0-9._@+= -]+$/
const PUBLIC_EXTENSIONS = new Set([
  ".csv",
  ".html",
  ".jpeg",
  ".jpg",
  ".json",
  ".md",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".svg",
  ".txt",
  ".webp",
])
const PUBLIC_CONTENT_TYPES = new Map<string, ReadonlySet<string>>([
  [".csv", new Set(["text/csv"])],
  [".html", new Set(["text/html"])],
  [".jpeg", new Set(["image/jpeg"])],
  [".jpg", new Set(["image/jpeg"])],
  [".json", new Set(["application/json"])],
  [".md", new Set(["text/markdown"])],
  [".mp3", new Set(["audio/mpeg"])],
  [".mp4", new Set(["video/mp4"])],
  [".pdf", new Set(["application/pdf"])],
  [".png", new Set(["image/png"])],
  [".svg", new Set(["image/svg+xml"])],
  [".txt", new Set(["text/plain"])],
  [".webp", new Set(["image/webp"])],
])

let client: S3Client | null = null

const PRIVATE_BYTE_LIMITS = {
  contextActive: 4,
  ownerActive: 8,
  globalActive: 200,
  contextHourlyUnits: 512 * 1024 * 1024,
  ownerHourlyUnits: 2 * 1024 * 1024 * 1024,
  globalHourlyUnits: 100 * 1024 * 1024 * 1024,
  leaseMs: 5 * 60 * 1000,
} as const
const PUBLIC_BYTE_LIMITS = {
  contextActive: 2,
  ownerActive: 4,
  globalActive: 100,
  contextHourlyUnits: 200 * 1024 * 1024,
  ownerHourlyUnits: 500 * 1024 * 1024,
  globalHourlyUnits: 20 * 1024 * 1024 * 1024,
  leaseMs: 5 * 60 * 1000,
} as const
const PRIVATE_OBJECT_LIMITS = {
  contextActive: 8,
  ownerActive: 16,
  globalActive: 400,
  contextHourlyUnits: 1_000,
  ownerHourlyUnits: 2_000,
  globalHourlyUnits: 100_000,
  leaseMs: 5 * 60 * 1000,
} as const
const PUBLIC_OBJECT_LIMITS = {
  contextActive: 4,
  ownerActive: 8,
  globalActive: 200,
  contextHourlyUnits: 100,
  ownerHourlyUnits: 200,
  globalHourlyUnits: 10_000,
  leaseMs: 5 * 60 * 1000,
} as const

export class WorkspaceStorageAdmissionError extends Error {
  constructor(readonly reason: string) {
    super(`Workspace storage admission rejected: ${reason}`)
    this.name = "WorkspaceStorageAdmissionError"
  }
}

export class WorkspaceStorageCompletionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceStorageCompletionError"
  }
}

class WorkspaceStorageSettlementUncertainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceStorageSettlementUncertainError"
  }
}

function expectedLength(
  value: number,
  maximum: number,
  minimum = 1,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`Invalid content length; maximum is ${maximum} bytes`)
  }
  return value
}

async function reserveUpload(params: {
  publicArtifact: boolean
  ownerEmail: string
  contextKey: string
  idempotencyKey: string
  contentLength: number
}): Promise<readonly [string | null, string | null]> {
  const prefix = params.publicArtifact ? "public" : "private"
  const byteAdmission = await acquireResourceAdmission({
    kind: `workspace-${prefix}-upload-bytes`,
    ownerKey: params.ownerEmail,
    contextKey: params.contextKey,
    idempotencyKey: `${params.idempotencyKey}:bytes`,
    units: Math.max(1, params.contentLength),
    limits: params.publicArtifact ? PUBLIC_BYTE_LIMITS : PRIVATE_BYTE_LIMITS,
  })
  // OBSERVE-ONLY (2026-07-27, Hagel). These thresholds were set in #1353
  // without data on real usage; crossing one is measured and logged, never a
  // refusal. NOTE this is a STORAGE bound, not a rate limit — if unbounded
  // growth becomes a problem the answer is a limit set from these numbers,
  // not a silent throw at the user.
  if (!byteAdmission.allowed && !isCapacityDenial(byteAdmission)) {
    // `duplicate` = replay of an idempotency key. Still a hard failure: a
    // second reservation for the same upload must not be created.
    throw new WorkspaceStorageAdmissionError(byteAdmission.reason)
  }
  if (!byteAdmission.allowed) {
    log.warn("Workspace upload bytes over threshold (observe-only — upload allowed)", {
      ownerEmail: params.ownerEmail,
      contextKey: params.contextKey,
      contentLength: params.contentLength,
      reason: byteAdmission.reason,
    })
  }
  const objectAdmission = await acquireResourceAdmission({
    kind: `workspace-${prefix}-upload-objects`,
    ownerKey: params.ownerEmail,
    contextKey: params.contextKey,
    idempotencyKey: `${params.idempotencyKey}:object`,
    units: 1,
    limits: params.publicArtifact ? PUBLIC_OBJECT_LIMITS : PRIVATE_OBJECT_LIMITS,
  })
  if (!objectAdmission.allowed && !isCapacityDenial(objectAdmission)) {
    if (byteAdmission.allowed) await releaseResourceAdmission(byteAdmission.leaseId)
    throw new WorkspaceStorageAdmissionError(objectAdmission.reason)
  }
  if (!objectAdmission.allowed) {
    log.warn("Workspace upload objects over threshold (observe-only — upload allowed)", {
      ownerEmail: params.ownerEmail,
      contextKey: params.contextKey,
      reason: objectAdmission.reason,
    })
  }
  // A denial carries no leaseId. Positions are preserved (byte, then object)
  // because they are persisted into distinct columns.
  return [
    byteAdmission.allowed ? byteAdmission.leaseId : null,
    objectAdmission.allowed ? objectAdmission.leaseId : null,
  ]
}

function expectedChecksum(value: string): string {
  if (!SHA256_BASE64_RE.test(value)) {
    throw new Error("Invalid SHA-256 checksum")
  }
  return value
}

function expectedContentType(value?: string): string {
  const normalized = (value ?? "application/octet-stream").trim().toLowerCase()
  if (normalized.length > 255) {
    throw new Error("Invalid content type")
  }
  const parts = normalized.split(";").map((part) => part.trim())
  const mediaType = parts.shift() ?? ""
  if (
    !CONTENT_TYPE_RE.test(mediaType) ||
    parts.length > 1 ||
    (parts.length === 1 && parts[0] !== "charset=utf-8")
  ) {
    throw new Error("Invalid content type")
  }
  return parts.length === 1 ? `${mediaType}; charset=utf-8` : mediaType
}

function assertPublicArtifactContentType(
  fileName: string,
  contentType: string,
): void {
  const extensionIndex = fileName.lastIndexOf(".")
  const extension =
    extensionIndex === -1 ? "" : fileName.slice(extensionIndex).toLowerCase()
  const mediaType = contentType.split(";", 1)[0] ?? ""
  if (!PUBLIC_CONTENT_TYPES.get(extension)?.has(mediaType)) {
    throw new Error("Invalid content type for public artifact extension")
  }
}

export function workspacePublicReconciliationCutoff(now: Date): Date {
  return new Date(
    now.getTime() -
      PUBLIC_LEDGER_RECONCILIATION_DAYS * 24 * 60 * 60 * 1000,
  )
}

function isS3ObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as {
    name?: unknown
    $metadata?: { httpStatusCode?: unknown }
  }
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    candidate.name === "NoSuchKey" ||
    candidate.name === "NoSuchVersion" ||
    candidate.name === "NotFound"
  )
}

async function reconcileExpiredPublicReservations(
  ownerEmail: string,
): Promise<void> {
  const ownerKey = ownerEmail.trim().toLowerCase()
  const candidates = await executeQuery(
    (db) =>
      db
        .select({
          id: workspaceUploadReservations.id,
          targetKey: workspaceUploadReservations.targetKey,
          objectVersionId: workspaceUploadReservations.objectVersionId,
        })
        .from(workspaceUploadReservations)
        .where(
          and(
            eq(workspaceUploadReservations.ownerKey, ownerKey),
            eq(workspaceUploadReservations.publicArtifact, true),
            eq(workspaceUploadReservations.status, "committed"),
            isNotNull(workspaceUploadReservations.objectVersionId),
            lt(
              workspaceUploadReservations.committedAt,
              workspacePublicReconciliationCutoff(new Date()),
            ),
          ),
        )
        .limit(25),
    "findExpiredPublicWorkspaceUploads",
  )
  for (const candidate of candidates) {
    if (!candidate.objectVersionId) continue
    const objectVersionId = candidate.objectVersionId
    try {
      await s3Client().send(
        new HeadObjectCommand({
          Bucket: bucketName(),
          Key: candidate.targetKey,
          VersionId: objectVersionId,
        }),
      )
    } catch (error) {
      if (!isS3ObjectNotFound(error)) continue
      await executeQuery(
        (db) =>
          db
            .update(workspaceUploadReservations)
            .set({ status: "expired", updatedAt: new Date() })
            .where(
              and(
                eq(workspaceUploadReservations.id, candidate.id),
                eq(workspaceUploadReservations.ownerKey, ownerKey),
                eq(workspaceUploadReservations.publicArtifact, true),
                eq(workspaceUploadReservations.status, "committed"),
                eq(
                  workspaceUploadReservations.objectVersionId,
                  objectVersionId,
                ),
              ),
            ),
        "expireDeletedPublicWorkspaceUpload",
      )
    }
  }
}

/**
 * Settle/release helpers that tolerate a NULL lease.
 *
 * Since migration 154 an upload may be admitted with no lease (the admission
 * gates are observe-only), so reconciliation must treat NULL as "nothing to
 * settle" rather than passing it downstream.
 */
const settleLease = (leaseId: string | null, units?: number) =>
  leaseId ? finishResourceAdmission(leaseId, units) : Promise.resolve()
const dropLease = (leaseId: string | null) =>
  leaseId ? releaseResourceAdmission(leaseId) : Promise.resolve()

function publicUrl(bucket: string, key: string): string {
  const region = process.env.AWS_REGION || "us-east-1"
  const encodedKey = key.split("/").map(encodeURIComponent).join("/")
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`
}

async function createUploadReservation(params: {
  publicArtifact: boolean
  ownerEmail: string
  contextKey: string
  idempotencyKey: string
  targetKey: string
  expectedBytes: number
  checksumSha256: string
  contentType: string
  leaseIds: readonly [string | null, string | null]
}): Promise<{ id: string; stagingKey: string }> {
  const ownerKey = params.ownerEmail.trim().toLowerCase()
  const id = randomUUID()
  const stagingKey = `.upload-staging/${
    params.publicArtifact ? "public" : "private"
  }/${createHash("sha256").update(ownerKey).digest("hex").slice(0, 24)}/${id}`
  const now = new Date()
  try {
    return await executeTransaction(
      async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace-upload:${ownerKey}:${params.publicArtifact}`}, 0))`,
        )
        await tx
          .update(workspaceUploadReservations)
          .set({ status: "expired", updatedAt: now })
          .where(
            and(
              eq(workspaceUploadReservations.ownerKey, ownerKey),
              eq(
                workspaceUploadReservations.publicArtifact,
                params.publicArtifact,
              ),
              eq(workspaceUploadReservations.status, "reserved"),
              lt(workspaceUploadReservations.expiresAt, now),
            ),
          )
        const retainedCondition = and(
          eq(workspaceUploadReservations.ownerKey, ownerKey),
          eq(
            workspaceUploadReservations.publicArtifact,
            params.publicArtifact,
          ),
          inArray(workspaceUploadReservations.status, RETAINED_UPLOAD_STATUSES),
        )
        const [byteRows, objectRows] = await Promise.all([
          tx
            .select({ value: sum(workspaceUploadReservations.expectedBytes) })
            .from(workspaceUploadReservations)
            .where(retainedCondition),
          tx
            .select({ value: count() })
            .from(workspaceUploadReservations)
            .where(retainedCondition),
        ])
        const quotaReason = workspaceRetainedQuotaReason(
          Number(byteRows[0]?.value ?? 0),
          Number(objectRows[0]?.value ?? 0),
          params.expectedBytes,
          params.publicArtifact,
        )
        // OBSERVE-ONLY (2026-07-27, Hagel). This is the RETAINED-storage
        // quota — total bytes/objects an owner keeps, not a request rate.
        // It is the one gate here with a genuine unbounded-growth risk, so
        // the log line is deliberately loud enough to alarm on: if S3 spend
        // starts climbing, this is the signal, and the limit should be reset
        // from these numbers rather than reinstated blind.
        if (quotaReason) {
          log.warn(
            "Workspace retained-storage quota over threshold (observe-only — upload allowed)",
            {
              ownerKey,
              contextKey: params.contextKey,
              expectedBytes: params.expectedBytes,
              publicArtifact: params.publicArtifact,
              reason: quotaReason,
            },
          )
        }
        await tx.insert(workspaceUploadReservations).values({
          id,
          ownerKey,
          contextKey: params.contextKey,
          idempotencyKey: params.idempotencyKey,
          publicArtifact: params.publicArtifact,
          stagingKey,
          targetKey: params.targetKey,
          expectedBytes: params.expectedBytes,
          checksumSha256: params.checksumSha256,
          contentType: params.contentType,
          byteLeaseId: params.leaseIds[0],
          objectLeaseId: params.leaseIds[1],
          expiresAt: new Date(now.getTime() + UPLOAD_RESERVATION_MS),
        })
        return { id, stagingKey }
      },
      "createWorkspaceUploadReservation",
    )
  } catch (error) {
    await Promise.all(
      params.leaseIds.filter((id): id is string => id !== null).map(releaseResourceAdmission),
    )
    throw error
  }
}

function assertSignedUploadHeaders(
  uploadUrl: string,
  contentLength: number,
  checksumSha256: string,
  contentType: string,
): {
  "Content-Length": string
  "Content-Type": string
  "x-amz-checksum-sha256": string
} {
  const signed = new URL(uploadUrl).searchParams
    .get("X-Amz-SignedHeaders")
    ?.toLowerCase()
    .split(";")
  if (
    !signed?.includes("content-length") ||
    !signed.includes("content-type") ||
    !signed.includes("x-amz-checksum-sha256")
  ) {
    throw new Error("Upload signer did not bind required integrity headers")
  }
  return {
    "Content-Length": String(contentLength),
    "Content-Type": contentType,
    "x-amz-checksum-sha256": checksumSha256,
  }
}

type UploadPreparation = {
  uploadUrl: string
  reservationId: string
  requiredHeaders: {
    "Content-Length": string
    "Content-Type": string
    "x-amz-checksum-sha256": string
  }
}

export async function signUploadReservation(params: {
  reservationId: string
  stagingKey: string
  contentLength: number
  checksumSha256: string
  contentType: string
}): Promise<UploadPreparation> {
  const uploadUrl = await getSignedUrl(
    s3Client(),
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: params.stagingKey,
      ContentLength: params.contentLength,
      ChecksumSHA256: params.checksumSha256,
      ContentType: params.contentType,
    }),
    {
      expiresIn: 120,
      unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      signableHeaders: new Set(["content-type"]),
    },
  )
  return {
    uploadUrl,
    reservationId: params.reservationId,
    requiredHeaders: assertSignedUploadHeaders(
      uploadUrl,
      params.contentLength,
      params.checksumSha256,
      params.contentType,
    ),
  }
}

async function existingUploadReservation(
  ownerEmail: string,
  idempotencyKey: string,
): Promise<typeof workspaceUploadReservations.$inferSelect | undefined> {
  const [existing] = await executeQuery(
    (db) =>
      db
        .select()
        .from(workspaceUploadReservations)
        .where(
          and(
            eq(
              workspaceUploadReservations.ownerKey,
              ownerEmail.trim().toLowerCase(),
            ),
            eq(workspaceUploadReservations.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1),
    "getExistingWorkspaceUploadReservation",
  )
  return existing
}

function s3Client(): S3Client {
  if (!client) {
    client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" })
  }
  return client
}

function bucketName(): string {
  const bucket = process.env.AGENT_WORKSPACE_BUCKET
  if (!bucket) throw new Error("Agent workspace storage is not configured")
  return bucket
}

async function assertRetiredExecApprovalsObjectSafe(params: {
  signedWorkspacePrefix: string
  relativePath: string
  key: string
  size: number
  eTag: string
  versionId?: string
}): Promise<void> {
  const pathReason = validateRetiredExecApprovalsPath(params.relativePath)
  let reason: string | null = pathReason
  if (!reason) {
    try {
      const response = await s3Client().send(
        new GetObjectCommand({
          Bucket: bucketName(),
          Key: params.key,
          ...(params.versionId ? { VersionId: params.versionId } : {}),
          IfMatch: params.eTag,
          Range: `bytes=0-${MAX_RETIRED_EXEC_APPROVALS_BYTES - 1}`,
        }),
      )
      if (!response.Body) {
        reason = "missing-body"
      } else {
        const body = await response.Body.transformToByteArray()
        reason = validateRetiredExecApprovalsRead(
          { size: params.size, eTag: params.eTag },
          {
            size: response.ContentLength ?? -1,
            eTag: response.ETag ?? "",
            body,
          },
        )
      }
    } catch {
      reason = "bounded-read-failed"
    }
  }
  if (!reason) return
  log.warn("Retired workspace host state is not safe to exclude", {
    ownerHash: createHash("sha256")
      .update(params.signedWorkspacePrefix)
      .digest("hex")
      .slice(0, 16),
    pathHash: createHash("sha256")
      .update(params.relativePath)
      .digest("hex")
      .slice(0, 16),
    reason,
  })
  throw new WorkspaceStorageCompletionError(
    "Retired workspace host state requires controlled migration",
  )
}

function validateTrustedPrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "")
  if (!normalized || normalized.includes("..") || normalized.includes("\\")) {
    throw new Error("Invalid signed workspace prefix")
  }
  return normalized
}

export function ownerWorkspaceKey(
  signedWorkspacePrefix: string,
  relativePath: string
): string {
  const key = `${validateTrustedPrefix(signedWorkspacePrefix)}/${validateWorkspaceRelativePath(relativePath)}`
  if (Buffer.byteLength(key, "utf8") > 1_024) {
    throw new Error("Invalid workspace object key length")
  }
  return key
}

export type WorkspaceGenerationEntry = {
  path: string
  size: number
  eTag: string
}

export type WorkspaceCheckpointSnapshot = {
  workspaceGeneration: string
  entries: WorkspaceGenerationEntry[]
}

export type EnsureWorkspaceCheckpointResult = {
  checkpointReady: true
  workspaceGeneration: string
  atomicCheckpointCommitVersion?: 1
  checkpointFinalizationProof?: string
  checkpointSnapshot?: WorkspaceCheckpointSnapshot
}

type WorkspaceFinalizationBinding = {
  invocationNonce: string
  expiresAt: number
}

type WorkspaceFinalizationProofClaims = {
  version: 1
  signedWorkspacePrefix: string
  workspaceGeneration: string
  invocationNonce: string
  expiresAt: number
}

async function workspaceFinalizationProofSecret(): Promise<string> {
  const inline = process.env.AGENT_INVOCATION_SIGNING_SECRET
  if (inline) return inline
  const secretId = process.env.AGENT_INVOCATION_SIGNING_SECRET_ID
  if (!secretId) {
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization proof secret is unavailable",
    )
  }
  const secret = await getSecretString(secretId)
  if (!secret) {
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization proof secret is unavailable",
    )
  }
  return secret
}

async function createWorkspaceFinalizationProof(
  signedWorkspacePrefix: string,
  workspaceGeneration: string,
  binding: WorkspaceFinalizationBinding,
): Promise<string> {
  const claims: WorkspaceFinalizationProofClaims = {
    version: 1,
    signedWorkspacePrefix: validateTrustedPrefix(
      signedWorkspacePrefix,
    ),
    workspaceGeneration,
    invocationNonce: binding.invocationNonce,
    expiresAt: binding.expiresAt,
  }
  const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  )
  const signature = createHmac(
    "sha256",
    await workspaceFinalizationProofSecret(),
  )
    .update(`${WORKSPACE_FINALIZATION_PROOF_VERSION}.${encoded}`)
    .digest("base64url")
  return `${WORKSPACE_FINALIZATION_PROOF_VERSION}.${encoded}.${signature}`
}

// Proof verification deliberately checks every authenticated claim before use.
// eslint-disable-next-line complexity
async function verifyWorkspaceFinalizationProof(
  proof: string,
  expected: WorkspaceFinalizationProofClaims,
): Promise<void> {
  if (
    !proof ||
    Buffer.byteLength(proof, "utf8") >
      MAX_WORKSPACE_FINALIZATION_PROOF_BYTES
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization proof is invalid",
    )
  }
  const parts = proof.split(".")
  if (
    parts.length !== 3 ||
    parts[0] !== WORKSPACE_FINALIZATION_PROOF_VERSION ||
    !parts[1] ||
    !parts[2]
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization proof is invalid",
    )
  }
  const expectedSignature = createHmac(
    "sha256",
    await workspaceFinalizationProofSecret(),
  )
    .update(`${parts[0]}.${parts[1]}`)
    .digest()
  let providedSignature: Buffer
  let claims: unknown
  try {
    providedSignature = Buffer.from(parts[2], "base64url")
    claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    )
  } catch {
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization proof is invalid",
    )
  }
  if (providedSignature.length !== expectedSignature.length) {
    timingSafeEqual(expectedSignature, expectedSignature)
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization proof is invalid",
    )
  }
  if (!timingSafeEqual(providedSignature, expectedSignature)) {
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization proof is invalid",
    )
  }
  const candidate = claims as Partial<WorkspaceFinalizationProofClaims>
  if (
    !claims ||
    typeof claims !== "object" ||
    Array.isArray(claims) ||
    Object.keys(claims).length !== 5 ||
    candidate.version !== expected.version ||
    candidate.signedWorkspacePrefix !==
      expected.signedWorkspacePrefix ||
    candidate.workspaceGeneration !== expected.workspaceGeneration ||
    candidate.invocationNonce !== expected.invocationNonce ||
    candidate.expiresAt !== expected.expiresAt ||
    !Number.isInteger(candidate.expiresAt) ||
    candidate.expiresAt! < Math.floor(Date.now() / 1000)
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization proof is invalid",
    )
  }
}

/**
 * Hash mutable workspace state with the same unambiguous binary framing used
 * by the agent image. Router-owned attachments are immutable, written under
 * the owner lock, and explicitly pulled by path for each turn, so excluding
 * them avoids a full workspace restore for every new upload.
 */
function workspaceGenerationFromMatchingEntries(
  entries: readonly WorkspaceGenerationEntry[],
  include: (entry: WorkspaceGenerationEntry) => boolean,
): string {
  const digest = createHash("sha256")
  const sorted = [...entries]
    .filter(include)
    .map((entry) => ({
      ...entry,
      path: validateWorkspaceRelativePath(entry.path),
    }))
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.path, "utf8"),
        Buffer.from(right.path, "utf8"),
      ),
    )
  for (const entry of sorted) {
    if (
      !entry.path ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !entry.eTag
    ) {
      throw new WorkspaceStorageCompletionError(
        "Workspace generation metadata is incomplete",
      )
    }
    const path = Buffer.from(entry.path, "utf8")
    const eTag = Buffer.from(entry.eTag, "utf8")
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(path.length))
    const size = Buffer.alloc(8)
    size.writeBigUInt64BE(BigInt(entry.size))
    const eTagLength = Buffer.alloc(8)
    eTagLength.writeBigUInt64BE(BigInt(eTag.length))
    digest.update(length)
    digest.update(path)
    digest.update(size)
    digest.update(eTagLength)
    digest.update(eTag)
  }
  return digest.digest("hex")
}

export function workspaceGenerationFromEntries(
  entries: readonly WorkspaceGenerationEntry[],
): string {
  return workspaceGenerationFromMatchingEntries(
    entries,
    (entry) => isCheckpointManagedWorkspacePath(entry.path),
  )
}

function legacyWorkspaceCheckpointGeneration(
  entries: readonly WorkspaceGenerationEntry[],
): string {
  return workspaceGenerationFromMatchingEntries(
    entries,
    (entry) =>
      isCheckpointManagedWorkspacePath(entry.path) ||
      RETIRED_WORKSPACE_CHECKPOINT_PATHS.has(entry.path),
  )
}

export function publicArtifactKey(ownerEmail: string, fileName: string): string {
  const safeName = validateWorkspaceRelativePath(fileName)
  if (safeName.includes("/") || !SAFE_PUBLIC_ARTIFACT_NAME.test(safeName)) {
    throw new Error("Invalid public artifact name")
  }
  const extensionIndex = safeName.lastIndexOf(".")
  const extension = extensionIndex === -1 ? "" : safeName.slice(extensionIndex).toLowerCase()
  if (!PUBLIC_EXTENSIONS.has(extension)) {
    throw new Error("Public artifact type is not allowed")
  }
  const owner = createHash("sha256").update(ownerEmail.toLowerCase()).digest("hex").slice(0, 24)
  return `public-images/${owner}/${safeName}`
}

export function validateOwnerPublicArtifactKey(
  ownerEmail: string,
  key: string
): string {
  const owner = createHash("sha256").update(ownerEmail.toLowerCase()).digest("hex").slice(0, 24)
  const prefix = `public-images/${owner}/`
  if (!key.startsWith(prefix)) throw new Error("Invalid owner public artifact key")
  const fileName = key.slice(prefix.length)
  if (!fileName || fileName.includes("/")) {
    throw new Error("Invalid owner public artifact key")
  }
  publicArtifactKey(ownerEmail, fileName)
  return key
}

export async function listWorkspaceObjects(
  signedWorkspacePrefix: string,
  continuationToken?: string
): Promise<{
  paths: string[]
  entries: Array<{
    path: string
    size: number
    lastModified: number
    eTag: string
  }>
  continuationToken?: string
}> {
  const prefix = `${validateTrustedPrefix(signedWorkspacePrefix)}/`
  const response = await s3Client().send(
    new ListObjectsV2Command({
      Bucket: bucketName(),
      Prefix: prefix,
      MaxKeys: MAX_LIST_KEYS,
      ContinuationToken: continuationToken,
    })
  )
  if (response.IsTruncated && !response.NextContinuationToken) {
    throw new WorkspaceStorageCompletionError(
      "Workspace listing ended before the final page",
    )
  }

  const listed = response.Contents ?? []
  const retired = listed.flatMap((entry) => {
    const key = entry.Key
    if (
      typeof key !== "string" ||
      !key.startsWith(prefix) ||
      key.length <= prefix.length
    ) return []
    const relativePath = key.slice(prefix.length)
    return RETIRED_WORKSPACE_CHECKPOINT_PATHS.has(relativePath)
      ? [{ entry, key, relativePath }]
      : []
  })
  // A claim means Doctor may have moved the source but not committed its
  // canonical SQLite row. Reject it without reading either object.
  for (const candidate of retired) {
    if (candidate.relativePath === RETIRED_EXEC_APPROVALS_CLAIM_PATH) {
      await assertRetiredExecApprovalsObjectSafe({
        signedWorkspacePrefix,
        relativePath: candidate.relativePath,
        key: candidate.key,
        size: candidate.entry.Size ?? -1,
        eTag: candidate.entry.ETag ?? "",
      })
    }
  }
  await Promise.all(
    retired.map((candidate) =>
      assertRetiredExecApprovalsObjectSafe({
        signedWorkspacePrefix,
        relativePath: candidate.relativePath,
        key: candidate.key,
        size: candidate.entry.Size ?? -1,
        eTag: candidate.entry.ETag ?? "",
      }),
    ),
  )

  const entries = listed
    .filter((entry): entry is typeof entry & { Key: string } => {
      const key = entry.Key
      if (
        typeof key !== "string" ||
        !key.startsWith(prefix) ||
        key.length <= prefix.length
      ) return false
      return !RETIRED_WORKSPACE_CHECKPOINT_PATHS.has(
        key.slice(prefix.length),
      )
    })
    .map((entry) => {
      const path = entry.Key.slice(prefix.length)
      const rejectionReason = isCheckpointManagedWorkspacePath(path)
        ? workspaceRelativePathRejectionReason(path)
        : null
      if (rejectionReason) {
        log.warn(
          "Persisted workspace path is incompatible with the storage contract",
          {
            pathHash: createHash("sha256")
              .update(path)
              .digest("hex")
              .slice(0, 16),
            rejectionReason,
          },
        )
        throw new WorkspaceStorageCompletionError(
          "Persisted workspace path is incompatible with the storage contract",
        )
      }
      return {
        path,
        size: entry.Size ?? 0,
        // Epoch SECONDS. The restore only ever compares these to each other to
        // rank recency, so second resolution is ample and avoids shipping a
        // date-string the client would have to parse.
        lastModified: entry.LastModified
          ? Math.floor(entry.LastModified.getTime() / 1000)
          : 0,
        // ETag is the collision-resistant object generation token the agent
        // image uses to prove a warm workspace has not gone stale between lock
        // acquisition and its final checkpoint. Keep the raw opaque value:
        // multipart/copy ETags are not necessarily content MD5s.
        eTag: entry.ETag ?? "",
      }
    })

  return {
    // `paths` is RETAINED for compatibility. Containers deploy independently of
    // this route, so an older image is always in flight during a rollout and
    // still reads this field. Removing it would break every running agent's
    // restore the moment the web tier deployed.
    paths: entries.map((entry) => entry.path),
    // Size + mtime come back on the SAME ListObjectsV2 response that already
    // produced the paths — the metadata was being discarded, so exposing it
    // costs no extra S3 call. The restore needs it to rank session transcripts
    // by recency instead of pulling all of them (see workspace_sync.py).
    entries,
    ...(response.NextContinuationToken
      ? { continuationToken: response.NextContinuationToken }
      : {}),
  }
}

type WorkspaceGenerationSnapshot = {
  generation: string
  entries: Map<string, WorkspaceGenerationEntry>
}

type WorkspaceCheckpointEntry = WorkspaceGenerationEntry & {
  /**
   * Exact recovery source for this committed object. A current target version
   * is lifecycle-safe and avoids copying every object during bootstrap.
   * Immediately before a committed target is overwritten, the broker copies
   * that exact version to the internal anchor namespace and atomically updates
   * this entry to `anchor` before promoting the new target version.
   */
  source: "target" | "anchor"
  versionId: string
  sourceETag: string
}

type WorkspaceCheckpointManifest = {
  version: typeof WORKSPACE_CHECKPOINT_VERSION
  signedWorkspacePrefix: string
  workspaceGeneration: string
  entries: WorkspaceCheckpointEntry[]
}

type ParsedWorkspaceCheckpointManifest = {
  manifest: WorkspaceCheckpointManifest
  normalizedRetiredPaths: boolean
  retiredEntries: WorkspaceCheckpointEntry[]
}

async function readWorkspaceGenerationSnapshot(
  signedWorkspacePrefix: string,
): Promise<WorkspaceGenerationSnapshot> {
  const entries = new Map<string, WorkspaceGenerationEntry>()
  let continuationToken: string | undefined
  const seenTokens = new Set<string>()
  do {
    const page = await listWorkspaceObjects(
      signedWorkspacePrefix,
      continuationToken,
    )
    if (page.paths.length !== page.entries.length) {
      throw new WorkspaceStorageCompletionError(
        "Workspace generation metadata is incomplete",
      )
    }
    for (const entry of page.entries) {
      if (entries.has(entry.path)) {
        throw new WorkspaceStorageCompletionError(
          "Workspace listing contains a duplicate path",
        )
      }
      if (entries.size >= MAX_WORKSPACE_GENERATION_OBJECTS) {
        throw new WorkspaceStorageCompletionError(
          "Workspace generation object backstop reached",
        )
      }
      entries.set(entry.path, {
        path: entry.path,
        size: entry.size,
        eTag: entry.eTag,
      })
    }
    continuationToken = page.continuationToken
    if (continuationToken) {
      if (seenTokens.has(continuationToken)) {
        throw new WorkspaceStorageCompletionError(
          "Workspace listing repeated a continuation token",
        )
      }
      seenTokens.add(continuationToken)
    }
  } while (continuationToken)
  return {
    generation: workspaceGenerationFromEntries([...entries.values()]),
    entries,
  }
}

function checkpointNamespaceForControlPrefix(
  signedWorkspacePrefix: string,
  controlPrefix: string,
): string {
  const prefix = validateTrustedPrefix(signedWorkspacePrefix)
  const prefixHash = createHash("sha256").update(prefix).digest("hex")
  return `${controlPrefix}/${prefixHash}`
}

function checkpointNamespace(signedWorkspacePrefix: string): string {
  return checkpointNamespaceForControlPrefix(
    signedWorkspacePrefix,
    WORKSPACE_CHECKPOINT_CONTROL_PREFIX,
  )
}

function checkpointManifestKey(signedWorkspacePrefix: string): string {
  return `${checkpointNamespace(signedWorkspacePrefix)}/manifest.json`
}

function legacyCheckpointManifestKey(
  signedWorkspacePrefix: string,
): string {
  return `${checkpointNamespaceForControlPrefix(
    signedWorkspacePrefix,
    LEGACY_WORKSPACE_CHECKPOINT_CONTROL_PREFIX,
  )}/manifest.json`
}

function checkpointAnchorKey(
  signedWorkspacePrefix: string,
  relativePath: string,
): string {
  const pathHash = createHash("sha256")
    .update(Buffer.from(relativePath, "utf8"))
    .digest("hex")
  return `${checkpointNamespace(signedWorkspacePrefix)}/anchors/${pathHash}`
}

function mutableWorkspaceEntries(
  snapshot: WorkspaceGenerationSnapshot,
): WorkspaceGenerationEntry[] {
  return [...snapshot.entries.values()]
    .filter((entry) => isCheckpointManagedWorkspacePath(entry.path))
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.path, "utf8"),
        Buffer.from(right.path, "utf8"),
      ),
    )
}

function inlineWorkspaceCheckpointSnapshot(
  snapshot: WorkspaceGenerationSnapshot,
): WorkspaceCheckpointSnapshot | undefined {
  const entries: WorkspaceGenerationEntry[] = []
  const serializedPrefix =
    `{"workspaceGeneration":${JSON.stringify(
      snapshot.generation,
    )},"entries":[`
  let serializedBytes =
    Buffer.byteLength(serializedPrefix, "utf8") +
    Buffer.byteLength("]}", "utf8")
  for (const entry of snapshot.entries.values()) {
    if (!isCheckpointManagedWorkspacePath(entry.path)) continue
    const responseEntry: WorkspaceGenerationEntry = {
      path: entry.path,
      size: entry.size,
      eTag: entry.eTag,
    }
    serializedBytes +=
      (entries.length === 0 ? 0 : 1) +
      Buffer.byteLength(JSON.stringify(responseEntry), "utf8")
    if (
      serializedBytes > MAX_INLINE_WORKSPACE_CHECKPOINT_SNAPSHOT_BYTES
    ) {
      return undefined
    }
    entries.push(responseEntry)
  }
  entries.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.path, "utf8"),
      Buffer.from(right.path, "utf8"),
    ),
  )
  const workspaceGeneration = workspaceGenerationFromEntries(entries)
  if (workspaceGeneration !== snapshot.generation) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint snapshot generation is incomplete",
    )
  }
  const candidate: WorkspaceCheckpointSnapshot = {
    workspaceGeneration,
    entries,
  }
  return candidate
}

function assertPrefixFreeWorkspaceEntries(
  entries: readonly WorkspaceGenerationEntry[],
): void {
  const paths = new Set(entries.map((entry) => entry.path))
  for (const entry of entries) {
    const parts = entry.path.split("/")
    for (let index = 1; index < parts.length; index += 1) {
      if (paths.has(parts.slice(0, index).join("/"))) {
        throw new WorkspaceStorageCompletionError(
          "Workspace contains conflicting file and descendant paths",
        )
      }
    }
  }
}

async function mapWithWorkspaceCheckpointConcurrency<T, U>(
  values: readonly T[],
  operation: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (values.length === 0) return []
  const results = Array.from({ length: values.length }) as U[]
  let nextIndex = 0
  let failed = false
  let firstError: unknown
  const workers = Array.from(
    {
      length: Math.min(
        WORKSPACE_CHECKPOINT_CONCURRENCY,
        values.length,
      ),
    },
    async () => {
      while (!failed) {
        const index = nextIndex
        nextIndex += 1
        if (index >= values.length) return
        try {
          results[index] = await operation(values[index]!, index)
        } catch (error) {
          if (!failed) {
            failed = true
            firstError = error
          }
          return
        }
      }
    },
  )
  await Promise.all(workers)
  if (failed) throw firstError
  return results
}

// Fail-closed structural validation intentionally checks every persisted field.
// eslint-disable-next-line complexity
function parseWorkspaceCheckpointManifest(
  value: unknown,
  signedWorkspacePrefix: string,
): ParsedWorkspaceCheckpointManifest {
  const expectedPrefix = validateTrustedPrefix(signedWorkspacePrefix)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint manifest is invalid",
    )
  }
  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== WORKSPACE_CHECKPOINT_VERSION ||
    candidate.signedWorkspacePrefix !== expectedPrefix ||
    typeof candidate.workspaceGeneration !== "string" ||
    !WORKSPACE_GENERATION_RE.test(candidate.workspaceGeneration) ||
    !Array.isArray(candidate.entries) ||
    candidate.entries.length > MAX_WORKSPACE_GENERATION_OBJECTS
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint manifest is invalid",
    )
  }
  const seenPaths = new Set<string>()
  const entries: WorkspaceCheckpointEntry[] = []
  for (const rawEntry of candidate.entries) {
    if (
      !rawEntry ||
      typeof rawEntry !== "object" ||
      Array.isArray(rawEntry)
    ) {
      throw new WorkspaceStorageCompletionError(
        "Workspace checkpoint manifest is invalid",
      )
    }
    const entry = rawEntry as Record<string, unknown>
    const pathIsRetired =
      typeof entry.path === "string" &&
      RETIRED_WORKSPACE_CHECKPOINT_PATHS.has(entry.path)
    if (
      typeof entry.path !== "string" ||
      workspaceRelativePathRejectionReason(entry.path) !== null ||
      (!isCheckpointManagedWorkspacePath(entry.path) && !pathIsRetired) ||
      seenPaths.has(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      typeof entry.eTag !== "string" ||
      entry.eTag.length === 0 ||
      entry.eTag.length > 1_024 ||
      (entry.source !== "target" && entry.source !== "anchor") ||
      typeof entry.versionId !== "string" ||
      entry.versionId.length === 0 ||
      entry.versionId.length > 1_024 ||
      typeof entry.sourceETag !== "string" ||
      entry.sourceETag.length === 0 ||
      entry.sourceETag.length > 1_024
    ) {
      throw new WorkspaceStorageCompletionError(
        "Workspace checkpoint manifest is invalid",
      )
    }
    if (entry.source === "target" && entry.sourceETag !== entry.eTag) {
      throw new WorkspaceStorageCompletionError(
        "Workspace checkpoint manifest is invalid",
      )
    }
    seenPaths.add(entry.path)
    entries.push({
      path: entry.path,
      size: entry.size as number,
      eTag: entry.eTag,
      source: entry.source,
      versionId: entry.versionId,
      sourceETag: entry.sourceETag,
    })
  }
  if (
    legacyWorkspaceCheckpointGeneration(entries) !==
    candidate.workspaceGeneration
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint generation is invalid",
    )
  }
  assertPrefixFreeWorkspaceEntries(entries)
  const normalizedEntries = entries
    .filter(
      (entry) => !RETIRED_WORKSPACE_CHECKPOINT_PATHS.has(entry.path),
    )
  normalizedEntries.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.path, "utf8"),
      Buffer.from(right.path, "utf8"),
    ),
  )
  return {
    manifest: {
      version: WORKSPACE_CHECKPOINT_VERSION,
      signedWorkspacePrefix: expectedPrefix,
      workspaceGeneration:
        workspaceGenerationFromEntries(normalizedEntries),
      entries: normalizedEntries,
    },
    normalizedRetiredPaths:
      normalizedEntries.length !== entries.length,
    retiredEntries: entries.filter((entry) =>
      RETIRED_WORKSPACE_CHECKPOINT_PATHS.has(entry.path),
    ),
  }
}

async function readWorkspaceCheckpointManifest(
  signedWorkspacePrefix: string,
): Promise<WorkspaceCheckpointManifest | null> {
  let response
  try {
    response = await s3Client().send(
      new GetObjectCommand({
        Bucket: bucketName(),
        Key: checkpointManifestKey(signedWorkspacePrefix),
      }),
    )
  } catch (error) {
    if (isS3ObjectNotFound(error)) return null
    throw error
  }
  const contentLength = response.ContentLength
  if (
    !Number.isSafeInteger(contentLength) ||
    !contentLength ||
    contentLength > MAX_WORKSPACE_CHECKPOINT_BYTES ||
    !response.Body
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint manifest is invalid",
    )
  }
  const serialized = await response.Body.transformToString("utf-8")
  if (Buffer.byteLength(serialized, "utf8") !== contentLength) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint manifest length is invalid",
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint manifest is invalid",
    )
  }
  const result = parseWorkspaceCheckpointManifest(
    parsed,
    signedWorkspacePrefix,
  )
  if (result.normalizedRetiredPaths) {
    for (const entry of result.retiredEntries) {
      await assertRetiredExecApprovalsObjectSafe({
        signedWorkspacePrefix,
        relativePath: entry.path,
        key: checkpointRecoverySourceKey(signedWorkspacePrefix, entry),
        size: entry.size,
        eTag: entry.sourceETag,
        versionId: entry.versionId,
      })
    }
    // Every caller holds the owner generation lock. This control-only rewrite
    // changes the manifest's definition of durable state but deliberately
    // leaves the retired, versioned owner object current and recoverable.
    await writeWorkspaceCheckpointManifest(result.manifest)
  }
  return result.manifest
}

async function assertNoLegacyWorkspaceCheckpoint(
  signedWorkspacePrefix: string,
): Promise<void> {
  try {
    await s3Client().send(
      new HeadObjectCommand({
        Bucket: bucketName(),
        Key: legacyCheckpointManifestKey(signedWorkspacePrefix),
      }),
    )
  } catch (error) {
    if (isS3ObjectNotFound(error)) return
    throw error
  }
  throw new WorkspaceStorageCompletionError(
    "Legacy workspace checkpoint must be recovered before v2 bootstrap",
  )
}

async function writeWorkspaceCheckpointManifest(
  manifest: WorkspaceCheckpointManifest,
): Promise<void> {
  const serialized = JSON.stringify(manifest)
  const contentLength = Buffer.byteLength(serialized, "utf8")
  if (contentLength > MAX_WORKSPACE_CHECKPOINT_BYTES) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint manifest exceeds its size backstop",
    )
  }
  const written = await s3Client().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: checkpointManifestKey(manifest.signedWorkspacePrefix),
      Body: serialized,
      ContentLength: contentLength,
      ContentType: "application/json",
      Tagging: "Scope=checkpoint",
    }),
  )
  if (!written.VersionId) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint manifest returned no object version",
    )
  }
}

function versionedCopySource(
  bucket: string,
  key: string,
  versionId: string,
): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/")
  return `${bucket}/${encodedKey}?versionId=${encodeURIComponent(versionId)}`
}

async function currentCheckpointEntry(
  signedWorkspacePrefix: string,
  entry: WorkspaceGenerationEntry,
): Promise<WorkspaceCheckpointEntry> {
  const key = ownerWorkspaceKey(signedWorkspacePrefix, entry.path)
  const metadata = await s3Client().send(
    new HeadObjectCommand({
      Bucket: bucketName(),
      Key: key,
    }),
  )
  if (
    metadata.ContentLength !== entry.size ||
    metadata.ETag !== entry.eTag ||
    !metadata.VersionId
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace changed while capturing its checkpoint",
    )
  }
  return {
    ...entry,
    source: "target",
    versionId: metadata.VersionId,
    sourceETag: entry.eTag,
  }
}

async function captureWorkspaceCheckpointManifest(
  signedWorkspacePrefix: string,
  snapshot: WorkspaceGenerationSnapshot,
  previous?: WorkspaceCheckpointManifest,
): Promise<WorkspaceCheckpointManifest> {
  assertPrefixFreeWorkspaceEntries([...snapshot.entries.values()])
  const previousByPath = new Map(
    previous?.entries.map((entry) => [entry.path, entry]) ?? [],
  )
  const entries = await mapWithWorkspaceCheckpointConcurrency(
    mutableWorkspaceEntries(snapshot),
    async (entry) => {
      const prior = previousByPath.get(entry.path)
      if (
        prior &&
        prior.size === entry.size &&
        prior.eTag === entry.eTag
      ) {
        return prior
      }
      return currentCheckpointEntry(signedWorkspacePrefix, entry)
    },
  )
  if (
    workspaceGenerationFromEntries(entries) !== snapshot.generation
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace changed while capturing its checkpoint",
    )
  }
  return {
    version: WORKSPACE_CHECKPOINT_VERSION,
    signedWorkspacePrefix: validateTrustedPrefix(signedWorkspacePrefix),
    workspaceGeneration: snapshot.generation,
    entries,
  }
}

function checkpointRecoverySourceKey(
  signedWorkspacePrefix: string,
  entry: WorkspaceCheckpointEntry,
): string {
  return entry.source === "target"
    ? ownerWorkspaceKey(signedWorkspacePrefix, entry.path)
    : checkpointAnchorKey(signedWorkspacePrefix, entry.path)
}

async function restoreWorkspaceCheckpointEntry(
  signedWorkspacePrefix: string,
  entry: WorkspaceCheckpointEntry,
): Promise<WorkspaceCheckpointEntry> {
  const bucket = bucketName()
  const sourceKey = checkpointRecoverySourceKey(
    signedWorkspacePrefix,
    entry,
  )
  const source = await s3Client().send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: sourceKey,
      VersionId: entry.versionId,
    }),
  )
  if (
    source.ContentLength !== entry.size ||
    source.ETag !== entry.sourceETag
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint recovery source is unavailable",
    )
  }
  const targetKey = ownerWorkspaceKey(
    signedWorkspacePrefix,
    entry.path,
  )
  const copied = await s3Client().send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: targetKey,
      CopySource: versionedCopySource(
        bucket,
        sourceKey,
        entry.versionId,
      ),
      MetadataDirective: "COPY",
      Tagging: "Scope=private",
      TaggingDirective: "REPLACE",
    }),
  )
  const eTag = copied.CopyObjectResult?.ETag
  if (!copied.VersionId || !eTag) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint restore returned incomplete metadata",
    )
  }
  return {
    ...entry,
    eTag,
    ...(entry.source === "target"
      ? {
          versionId: copied.VersionId,
          sourceETag: eTag,
        }
      : {}),
  }
}

async function recoverWorkspaceCheckpoint(
  signedWorkspacePrefix: string,
  manifest: WorkspaceCheckpointManifest,
  snapshot: WorkspaceGenerationSnapshot,
): Promise<{
  manifest: WorkspaceCheckpointManifest
  snapshot: WorkspaceGenerationSnapshot
}> {
  const expected = new Map(
    manifest.entries.map((entry) => [entry.path, entry]),
  )
  const current = new Map(
    mutableWorkspaceEntries(snapshot).map((entry) => [
      entry.path,
      entry,
    ]),
  )
  const toRestore = manifest.entries.filter((entry) => {
    const listed = current.get(entry.path)
    return (
      !listed ||
      listed.size !== entry.size ||
      listed.eTag !== entry.eTag
    )
  })
  const toRemove = [...current.values()].filter(
    (entry) => !expected.has(entry.path),
  )
  const restored = await mapWithWorkspaceCheckpointConcurrency(
    toRestore,
    (entry) =>
      restoreWorkspaceCheckpointEntry(signedWorkspacePrefix, entry),
  )
  await mapWithWorkspaceCheckpointConcurrency(toRemove, async (entry) => {
    const deleted = await s3Client().send(
      new DeleteObjectCommand({
        Bucket: bucketName(),
        Key: ownerWorkspaceKey(
          signedWorkspacePrefix,
          entry.path,
        ),
      }),
    )
    // Omit VersionId intentionally: in a versioned bucket this creates a
    // delete marker and retains every historical object version.
    if (deleted.DeleteMarker !== true || !deleted.VersionId) {
      throw new WorkspaceStorageCompletionError(
        "Workspace checkpoint rollback was not version preserving",
      )
    }
  })

  const restoredByPath = new Map(
    restored.map((entry) => [entry.path, entry]),
  )
  const recoveredEntries = manifest.entries.map(
    (entry) => restoredByPath.get(entry.path) ?? entry,
  )
  const recoveredSnapshot = await readWorkspaceGenerationSnapshot(
    signedWorkspacePrefix,
  )
  const recoveredMutable = new Map(
    mutableWorkspaceEntries(recoveredSnapshot).map((entry) => [
      entry.path,
      entry,
    ]),
  )
  if (recoveredMutable.size !== recoveredEntries.length) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint recovery is incomplete",
    )
  }
  for (const entry of recoveredEntries) {
    const currentEntry = recoveredMutable.get(entry.path)
    if (
      !currentEntry ||
      currentEntry.size !== entry.size ||
      currentEntry.eTag !== entry.eTag
    ) {
      throw new WorkspaceStorageCompletionError(
        "Workspace checkpoint recovery is incomplete",
      )
    }
  }
  const recoveredManifest: WorkspaceCheckpointManifest = {
    ...manifest,
    workspaceGeneration: recoveredSnapshot.generation,
    entries: recoveredEntries,
  }
  if (
    workspaceGenerationFromEntries(recoveredEntries) !==
    recoveredSnapshot.generation
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint recovery generation is incomplete",
    )
  }
  if (
    recoveredManifest.workspaceGeneration !==
      manifest.workspaceGeneration ||
    recoveredEntries.some(
      (entry, index) =>
        entry.eTag !== manifest.entries[index]?.eTag ||
        entry.versionId !== manifest.entries[index]?.versionId,
    )
  ) {
    // A server-side copy may legitimately produce a different ETag. Publish
    // the equivalent recovered generation only after every target is restored.
    await writeWorkspaceCheckpointManifest(recoveredManifest)
  }
  return {
    manifest: recoveredManifest,
    snapshot: recoveredSnapshot,
  }
}

export async function ensureWorkspaceCheckpoint(
  signedWorkspacePrefix: string,
  finalizationBinding?: WorkspaceFinalizationBinding,
): Promise<EnsureWorkspaceCheckpointResult> {
  const checkpoint =
    await withWorkspaceGenerationLock<EnsureWorkspaceCheckpointResult>(
    signedWorkspacePrefix,
    async () => {
      let snapshot = await readWorkspaceGenerationSnapshot(
        signedWorkspacePrefix,
      )
      let manifest = await readWorkspaceCheckpointManifest(
        signedWorkspacePrefix,
      )
      if (!manifest) {
        await assertNoLegacyWorkspaceCheckpoint(signedWorkspacePrefix)
        manifest = await captureWorkspaceCheckpointManifest(
          signedWorkspacePrefix,
          snapshot,
        )
        await writeWorkspaceCheckpointManifest(manifest)
      } else if (
        snapshot.generation !== manifest.workspaceGeneration
      ) {
        const recovered = await recoverWorkspaceCheckpoint(
          signedWorkspacePrefix,
          manifest,
          snapshot,
        )
        manifest = recovered.manifest
        snapshot = recovered.snapshot
      }
      if (snapshot.generation !== manifest.workspaceGeneration) {
        throw new WorkspaceStorageCompletionError(
          "Workspace checkpoint snapshot generation is incomplete",
        )
      }
      const checkpointSnapshot = inlineWorkspaceCheckpointSnapshot(snapshot)
      return {
        checkpointReady: true as const,
        workspaceGeneration: manifest.workspaceGeneration,
        ...(checkpointSnapshot ? { checkpointSnapshot } : {}),
      }
    },
  )
  if (!finalizationBinding) return checkpoint
  if (
    !finalizationBinding.invocationNonce ||
    !Number.isInteger(finalizationBinding.expiresAt) ||
    finalizationBinding.expiresAt < Math.floor(Date.now() / 1000)
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization binding is invalid",
    )
  }
  return {
    ...checkpoint,
    atomicCheckpointCommitVersion: 1,
    checkpointFinalizationProof:
      await createWorkspaceFinalizationProof(
        signedWorkspacePrefix,
        checkpoint.workspaceGeneration,
        finalizationBinding,
      ),
  }
}

export async function commitWorkspaceCheckpoint(
  signedWorkspacePrefix: string,
  baseWorkspaceGeneration: string,
  workspaceGeneration: string,
): Promise<{
  checkpointCommitted: true
  workspaceGeneration: string
}> {
  if (
    !WORKSPACE_GENERATION_RE.test(baseWorkspaceGeneration) ||
    !WORKSPACE_GENERATION_RE.test(workspaceGeneration)
  ) {
    throw new Error("Invalid workspace checkpoint generation")
  }
  return withWorkspaceGenerationLock(
    signedWorkspacePrefix,
    async () => {
      let manifest = await readWorkspaceCheckpointManifest(
        signedWorkspacePrefix,
      )
      if (!manifest) {
        throw new WorkspaceStorageCompletionError(
          "Workspace checkpoint has not been initialized",
        )
      }
      const snapshot = await readWorkspaceGenerationSnapshot(
        signedWorkspacePrefix,
      )
      if (manifest.workspaceGeneration === workspaceGeneration) {
        if (snapshot.generation !== workspaceGeneration) {
          const recovered = await recoverWorkspaceCheckpoint(
            signedWorkspacePrefix,
            manifest,
            snapshot,
          )
          manifest = recovered.manifest
        }
        if (manifest.workspaceGeneration !== workspaceGeneration) {
          throw new WorkspaceStorageCompletionError(
            "Workspace checkpoint retry resolved to another generation",
          )
        }
        return {
          checkpointCommitted: true,
          workspaceGeneration,
        }
      }
      if (
        manifest.workspaceGeneration !== baseWorkspaceGeneration ||
        snapshot.generation !== workspaceGeneration
      ) {
        throw new WorkspaceStorageCompletionError(
          "Workspace checkpoint generation changed before commit",
        )
      }
      const nextManifest = await captureWorkspaceCheckpointManifest(
        signedWorkspacePrefix,
        snapshot,
        manifest,
      )
      // The manifest PutObject is the single commit point and always happens
      // after every changed/new path has an exact recovery VersionId.
      await writeWorkspaceCheckpointManifest(nextManifest)
      return {
        checkpointCommitted: true,
        workspaceGeneration,
      }
    },
  )
}

async function anchorCommittedCheckpointPathBeforePromotion(
  signedWorkspacePrefix: string,
  relativePath: string,
): Promise<void> {
  const manifest = await readWorkspaceCheckpointManifest(
    signedWorkspacePrefix,
  )
  if (!manifest) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint has not been initialized",
    )
  }
  const index = manifest.entries.findIndex(
    (entry) => entry.path === relativePath,
  )
  if (index === -1) {
    // A path created during the uncommitted batch has no committed version to
    // preserve. It will receive an exact current VersionId at final commit.
    return
  }
  const entry = manifest.entries[index]!
  if (entry.source === "anchor") {
    const anchored = await s3Client().send(
      new HeadObjectCommand({
        Bucket: bucketName(),
        Key: checkpointAnchorKey(
          signedWorkspacePrefix,
          relativePath,
        ),
        VersionId: entry.versionId,
      }),
    )
    if (
      anchored.ContentLength !== entry.size ||
      anchored.ETag !== entry.sourceETag
    ) {
      throw new WorkspaceStorageCompletionError(
        "Workspace checkpoint anchor is unavailable",
      )
    }
    return
  }

  const bucket = bucketName()
  const targetKey = ownerWorkspaceKey(
    signedWorkspacePrefix,
    relativePath,
  )
  const target = await s3Client().send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: targetKey,
      VersionId: entry.versionId,
    }),
  )
  if (
    target.ContentLength !== entry.size ||
    target.ETag !== entry.sourceETag
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint target version is unavailable",
    )
  }
  const anchored = await s3Client().send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: checkpointAnchorKey(
        signedWorkspacePrefix,
        relativePath,
      ),
      CopySource: versionedCopySource(
        bucket,
        targetKey,
        entry.versionId,
      ),
      MetadataDirective: "COPY",
      Tagging: "Scope=checkpoint",
      TaggingDirective: "REPLACE",
    }),
  )
  const anchorETag = anchored.CopyObjectResult?.ETag
  if (!anchored.VersionId || !anchorETag) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint anchor returned incomplete metadata",
    )
  }
  const entries = [...manifest.entries]
  entries[index] = {
    ...entry,
    source: "anchor",
    versionId: anchored.VersionId,
    sourceETag: anchorETag,
  }
  // This control-only manifest update keeps the same workspace generation.
  // It is durably committed before CopyObject can overwrite the target.
  await writeWorkspaceCheckpointManifest({
    ...manifest,
    entries,
  })
}

export async function deleteWorkspacePath(
  signedWorkspacePrefix: string,
  relativePath: string,
  expectedGeneration: string,
): Promise<{
  deleted: boolean
  workspaceGeneration: string
}> {
  const path = validateWorkspaceRelativePath(relativePath)
  if (
    !isCheckpointManagedWorkspacePath(path) ||
    !WORKSPACE_GENERATION_RE.test(expectedGeneration)
  ) {
    throw new Error("Invalid workspace delete request")
  }
  return withWorkspaceGenerationLock(
    signedWorkspacePrefix,
    async () => {
      const manifest = await readWorkspaceCheckpointManifest(
        signedWorkspacePrefix,
      )
      if (!manifest) {
        throw new WorkspaceStorageCompletionError(
          "Workspace checkpoint has not been initialized",
        )
      }
      const committedEntry = manifest.entries.find(
        (entry) => entry.path === path,
      )
      const snapshot = await readWorkspaceGenerationSnapshot(
        signedWorkspacePrefix,
      )
      const currentEntry = snapshot.entries.get(path)
      if (snapshot.generation !== expectedGeneration) {
        if (!currentEntry && committedEntry) {
          const reconstructed = [
            ...mutableWorkspaceEntries(snapshot),
            {
              path,
              size: committedEntry.size,
              eTag: committedEntry.eTag,
            },
          ]
          if (
            workspaceGenerationFromEntries(reconstructed) ===
            expectedGeneration
          ) {
            return {
              deleted: true,
              workspaceGeneration: snapshot.generation,
            }
          }
        }
        throw new WorkspaceStorageCompletionError(
          "Workspace generation changed before path deletion",
        )
      }
      if (!currentEntry) {
        return {
          deleted: false,
          workspaceGeneration: snapshot.generation,
        }
      }
      if (
        !committedEntry ||
        committedEntry.size !== currentEntry.size ||
        committedEntry.eTag !== currentEntry.eTag
      ) {
        throw new WorkspaceStorageCompletionError(
          "Workspace delete target is not in the committed checkpoint",
        )
      }
      await anchorCommittedCheckpointPathBeforePromotion(
        signedWorkspacePrefix,
        path,
      )
      const deleted = await s3Client().send(
        new DeleteObjectCommand({
          Bucket: bucketName(),
          Key: ownerWorkspaceKey(signedWorkspacePrefix, path),
        }),
      )
      // Versionless delete creates a marker while preserving every historical
      // object version for checkpoint rollback and audit recovery.
      if (deleted.DeleteMarker !== true || !deleted.VersionId) {
        throw new WorkspaceStorageCompletionError(
          "Workspace path deletion was not version preserving",
        )
      }
      const expectedNextGeneration = workspaceGenerationFromEntries(
        [...snapshot.entries.values()].filter(
          (entry) => entry.path !== path,
        ),
      )
      // S3 is strongly consistent, the versionless delete returned both a
      // delete marker and its VersionId, and this mutation still owns the
      // per-workspace advisory lock. Re-listing the entire workspace here is
      // therefore redundant. On large, migrated workspaces that second scan
      // takes longer than the agent's request timeout and causes an
      // overlapping idempotent retry. Derive the next generation from the
      // already-validated pre-delete snapshot, exactly as upload promotion
      // does below.
      return {
        deleted: true,
        workspaceGeneration: expectedNextGeneration,
      }
    },
  )
}

export async function createWorkspaceDownloadUrl(
  signedWorkspacePrefix: string,
  relativePath: string
): Promise<{
  downloadUrl: string
  contentLength: number
  requiredHeaders: { Range: string }
}> {
  const bucket = bucketName()
  const key = ownerWorkspaceKey(signedWorkspacePrefix, relativePath)
  const metadata = await s3Client().send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  )
  const contentLength = expectedLength(
    metadata.ContentLength ?? 0,
    MAX_PRIVATE_UPLOAD_BYTES,
  )
  const range = `bytes=0-${contentLength - 1}`
  const downloadUrl = await getSignedUrl(
    s3Client(),
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: range,
    }),
    { expiresIn: 120 }
  )
  return { downloadUrl, contentLength, requiredHeaders: { Range: range } }
}

type WorkspaceUploadResult =
  | UploadPreparation
  | {
      unchanged: true
      key: string
      eTag: string
    }

interface PrivateUploadParameters {
  ownerEmail: string
  contextKey: string
  idempotencyKey: string
  targetKey: string
  length: number
  checksum: string
  contentType: string
}

type ExistingUploadReservation = NonNullable<
  Awaited<ReturnType<typeof existingUploadReservation>>
>

async function committedUploadMatches(
  targetKey: string,
  objectVersionId: string,
  length: number,
  checksum: string,
  contentType: string,
): Promise<string | null> {
  const metadata = await s3Client().send(
    new HeadObjectCommand({
      Bucket: bucketName(),
      Key: targetKey,
      ChecksumMode: "ENABLED",
    }),
  )
  return (
    metadata.ContentLength === length &&
    metadata.ChecksumSHA256 === checksum &&
    metadata.ContentType === contentType &&
    metadata.VersionId === objectVersionId &&
    typeof metadata.ETag === "string" &&
    metadata.ETag.length > 0
  )
    ? metadata.ETag
    : null
}

async function reusePrivateUploadReservation(
  existing: ExistingUploadReservation,
  params: PrivateUploadParameters,
): Promise<WorkspaceUploadResult> {
  if (
    existing.publicArtifact ||
    existing.targetKey !== params.targetKey ||
    existing.expectedBytes !== params.length ||
    existing.checksumSha256 !== params.checksum ||
    existing.contentType !== params.contentType
  ) {
    throw new WorkspaceStorageCompletionError(
      "Idempotency key is bound to different upload parameters",
    )
  }
  if (existing.status === "committed") {
    if (!existing.objectVersionId) {
      throw new WorkspaceStorageCompletionError(
        "Committed upload has no verified object version",
      )
    }
    const eTag = await committedUploadMatches(
      params.targetKey,
      existing.objectVersionId,
      params.length,
      params.checksum,
      params.contentType,
    )
    if (!eTag) {
      throw new WorkspaceStorageCompletionError(
        "Committed upload no longer matches its reservation",
      )
    }
    return { unchanged: true, key: params.targetKey, eTag }
  }
  if (
    existing.status !== "reserved" ||
    existing.expiresAt.getTime() <= Date.now()
  ) {
    throw new WorkspaceStorageCompletionError(
      "Upload reservation is not reusable",
    )
  }
  return signUploadReservation({
    reservationId: existing.id,
    stagingKey: existing.stagingKey,
    contentLength: params.length,
    checksumSha256: params.checksum,
    contentType: params.contentType,
  })
}

async function findMatchingCommittedUpload(
  params: PrivateUploadParameters,
): Promise<WorkspaceUploadResult | null> {
  const [unchanged] = await executeQuery(
    (db) =>
      db
        .select({
          id: workspaceUploadReservations.id,
          targetKey: workspaceUploadReservations.targetKey,
          objectVersionId: workspaceUploadReservations.objectVersionId,
        })
        .from(workspaceUploadReservations)
        .where(
          and(
            eq(
              workspaceUploadReservations.ownerKey,
              params.ownerEmail.trim().toLowerCase(),
            ),
            eq(workspaceUploadReservations.targetKey, params.targetKey),
            eq(workspaceUploadReservations.expectedBytes, params.length),
            eq(workspaceUploadReservations.checksumSha256, params.checksum),
            eq(workspaceUploadReservations.contentType, params.contentType),
            eq(workspaceUploadReservations.status, "committed"),
          ),
        )
        .limit(1),
    "findUnchangedWorkspaceUpload",
  )
  if (!unchanged?.objectVersionId) return null
  try {
    const eTag = await committedUploadMatches(
      unchanged.targetKey,
      unchanged.objectVersionId,
      params.length,
      params.checksum,
      params.contentType,
    )
    return eTag
      ? { unchanged: true, key: params.targetKey, eTag }
      : null
  } catch {
    return null
  }
}

async function createAndSignPrivateUpload(
  params: PrivateUploadParameters,
): Promise<UploadPreparation> {
  const leaseIds = await reserveUpload({
    publicArtifact: false,
    ownerEmail: params.ownerEmail,
    contextKey: params.contextKey,
    idempotencyKey: params.idempotencyKey,
    contentLength: params.length,
  })
  const reservation = await createUploadReservation({
    publicArtifact: false,
    ownerEmail: params.ownerEmail,
    contextKey: params.contextKey,
    idempotencyKey: params.idempotencyKey,
    targetKey: params.targetKey,
    expectedBytes: params.length,
    checksumSha256: params.checksum,
    contentType: params.contentType,
    leaseIds,
  })
  try {
    return await signUploadReservation({
      reservationId: reservation.id,
      stagingKey: reservation.stagingKey,
      contentLength: params.length,
      checksumSha256: params.checksum,
      contentType: params.contentType,
    })
  } catch (error) {
    await executeQuery(
      (db) =>
        db
          .update(workspaceUploadReservations)
          .set({ status: "rejected", updatedAt: new Date() })
          .where(eq(workspaceUploadReservations.id, reservation.id)),
      "rejectWorkspaceUploadSigning",
    )
    await Promise.all(
      leaseIds
        .filter((id): id is string => id !== null)
        .map(releaseResourceAdmission),
    )
    throw error
  }
}

export async function createWorkspaceUploadUrl(
  options: {
    ownerEmail: string
    signedWorkspacePrefix: string
    relativePath: string
    contentLength: number
    contextKey: string
    idempotencyKey: string
    checksumSha256: string
    contentType?: string
  }
): Promise<WorkspaceUploadResult> {
  const {
    ownerEmail,
    signedWorkspacePrefix,
    relativePath,
    contentLength,
    contextKey,
    idempotencyKey,
    checksumSha256,
    contentType,
  } = options
  const length = expectedLength(
    contentLength,
    MAX_PRIVATE_UPLOAD_BYTES,
    0,
  )
  const checksum = expectedChecksum(checksumSha256)
  const normalizedContentType = expectedContentType(contentType)
  if (!isCheckpointManagedWorkspacePath(relativePath)) {
    throw new Error("Invalid workspace upload path")
  }
  const targetKey = ownerWorkspaceKey(signedWorkspacePrefix, relativePath)
  const params: PrivateUploadParameters = {
    ownerEmail,
    contextKey,
    idempotencyKey,
    targetKey,
    length,
    checksum,
    contentType: normalizedContentType,
  }
  const existing = await existingUploadReservation(ownerEmail, idempotencyKey)
  if (existing) return reusePrivateUploadReservation(existing, params)
  const unchanged = await findMatchingCommittedUpload(params)
  return unchanged ?? createAndSignPrivateUpload(params)
}

export async function createPublicArtifactUpload(
  options: {
    ownerEmail: string
    fileName: string
    contentType: string
    contentLength: number
    contextKey: string
    idempotencyKey: string
    checksumSha256: string
  }
): Promise<{
  uploadUrl: string
  reservationId: string
  requiredHeaders: {
    "Content-Length": string
    "Content-Type": string
    "x-amz-checksum-sha256": string
  }
}> {
  const {
    ownerEmail,
    fileName,
    contentType,
    contentLength,
    contextKey,
    idempotencyKey,
    checksumSha256,
  } = options
  const length = expectedLength(contentLength, MAX_PUBLIC_ARTIFACT_BYTES)
  const checksum = expectedChecksum(checksumSha256)
  const normalizedContentType = expectedContentType(contentType)
  const key = publicArtifactKey(ownerEmail, fileName)
  assertPublicArtifactContentType(fileName, normalizedContentType)
  const existing = await existingUploadReservation(ownerEmail, idempotencyKey)
  if (existing) {
    if (
      !existing.publicArtifact ||
      existing.targetKey !== key ||
      existing.expectedBytes !== length ||
      existing.checksumSha256 !== checksum ||
      existing.contentType !== normalizedContentType ||
      existing.status !== "reserved" ||
      existing.expiresAt.getTime() <= Date.now()
    ) {
      throw new WorkspaceStorageCompletionError(
        "Idempotency key is bound to a non-reusable upload",
      )
    }
    return signUploadReservation({
      reservationId: existing.id,
      stagingKey: existing.stagingKey,
      contentLength: length,
      checksumSha256: checksum,
      contentType: normalizedContentType,
    })
  }
  await reconcileExpiredPublicReservations(ownerEmail)
  const leaseIds = await reserveUpload({
    publicArtifact: true,
    ownerEmail,
    contextKey,
    idempotencyKey,
    contentLength: length,
  })
  const reservation = await createUploadReservation({
    publicArtifact: true,
    ownerEmail,
    contextKey,
    idempotencyKey,
    targetKey: key,
    expectedBytes: length,
    checksumSha256: checksum,
    contentType: normalizedContentType,
    leaseIds,
  })
  try {
    return await signUploadReservation({
      reservationId: reservation.id,
      stagingKey: reservation.stagingKey,
      contentLength: length,
      checksumSha256: checksum,
      contentType: normalizedContentType,
    })
  } catch (error) {
    await executeQuery(
      (db) =>
        db
          .update(workspaceUploadReservations)
          .set({ status: "rejected", updatedAt: new Date() })
          .where(eq(workspaceUploadReservations.id, reservation.id)),
      "rejectPublicUploadSigning",
    )
    await Promise.all(
      leaseIds.filter((id): id is string => id !== null).map(releaseResourceAdmission),
    )
    throw error
  }
}

type CompletedWorkspaceUpload = {
  key: string
  publicUrl?: string
  eTag?: string
  workspaceGeneration?: string
}
type WorkspaceUploadReservation =
  typeof workspaceUploadReservations.$inferSelect
const defaultDatabaseExecutor: UnretriedDatabaseSession = {
  executeQuery,
  executeTransaction: (transactionFn, context) =>
    executeTransaction(
      (tx) => transactionFn(tx as unknown as DrizzleDB),
      context,
    ),
}

async function claimUploadCompletion(
  ownerKey: string,
  reservationId: string,
  database: UnretriedDatabaseSession = defaultDatabaseExecutor,
  publicOnly = false,
  recoverVerifying = false,
): Promise<
  | { kind: "claimed"; reservation: WorkspaceUploadReservation }
  | { kind: "verifying"; reservation: WorkspaceUploadReservation }
  | {
      kind: "committed"
      reservation: WorkspaceUploadReservation
      result: CompletedWorkspaceUpload
    }
> {
  const [claimed] = await database.executeQuery(
    (db) =>
      db
        .update(workspaceUploadReservations)
        .set({ status: "verifying", updatedAt: new Date() })
        .where(
          and(
            eq(workspaceUploadReservations.id, reservationId),
            eq(workspaceUploadReservations.ownerKey, ownerKey),
            eq(workspaceUploadReservations.status, "reserved"),
            gt(workspaceUploadReservations.expiresAt, new Date()),
            publicOnly
              ? eq(workspaceUploadReservations.publicArtifact, true)
              : undefined,
          ),
        )
        .returning(),
    "claimWorkspaceUploadCompletion",
  )
  if (claimed) return { kind: "claimed", reservation: claimed }
  const [existing] = await database.executeQuery(
    (db) =>
      db
        .select()
        .from(workspaceUploadReservations)
        .where(
          and(
            eq(workspaceUploadReservations.id, reservationId),
            eq(workspaceUploadReservations.ownerKey, ownerKey),
          ),
        )
        .limit(1),
    "getWorkspaceUploadCompletion",
  )
  if (publicOnly && existing && !existing.publicArtifact) {
    throw new WorkspaceStorageCompletionError(
      "Private workspace upload requires an authoritative generation",
    )
  }
  if (
    recoverVerifying &&
    existing?.status === "verifying" &&
    !existing.publicArtifact
  ) {
    return { kind: "verifying", reservation: existing }
  }
  if (existing?.status !== "committed") {
    throw new WorkspaceStorageCompletionError(
      "Upload reservation is unavailable or already being verified",
    )
  }
  return {
    kind: "committed",
    reservation: existing,
    result: {
      key: existing.targetKey,
      ...(existing.publicArtifact
        ? { publicUrl: publicUrl(bucketName(), existing.targetKey) }
        : {}),
    },
  }
}

async function withWorkspaceGenerationLock<T>(
  signedWorkspacePrefix: string,
  operation: (database: UnretriedDatabaseSession) => Promise<T>,
): Promise<T> {
  const lockKey = `agent-workspace:${validateTrustedPrefix(
    signedWorkspacePrefix,
  )}`
  const configuredTimeout = Number.parseInt(
    process.env.WORKSPACE_GENERATION_LOCK_TIMEOUT_MS ?? "",
    10,
  )
  const timeoutMs =
    Number.isSafeInteger(configuredTimeout) &&
    configuredTimeout >= 1_000 &&
    configuredTimeout <= 60_000
      ? configuredTimeout
      : 15_000
  return withUnretriedDatabaseSession(
    async (database) => {
      const deadline = Date.now() + timeoutMs
      let acquired = false
      while (!acquired && Date.now() < deadline) {
        const result = await database.executeQuery(
          (db) =>
            db.execute(
              sql`SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS acquired`,
            ),
          "tryFenceWorkspaceUploadCompletion",
        )
        acquired =
          toPgRows<{ acquired: boolean }>(result)[0]?.acquired === true
        if (!acquired) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      if (!acquired) {
        throw new WorkspaceStorageCompletionError(
          "Workspace upload completion lock timed out",
        )
      }
      let outcome:
        | { ok: true; value: T }
        | { ok: false; error: unknown }
      try {
        outcome = { ok: true, value: await operation(database) }
      } catch (error) {
        outcome = { ok: false, error }
      }
      const result = await database.executeQuery(
        (db) =>
          db.execute(
            sql`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0)) AS released`,
          ),
        "releaseWorkspaceUploadCompletionFence",
      )
      if (
        toPgRows<{ released: boolean }>(result)[0]?.released !== true
      ) {
        throw new WorkspaceStorageSettlementUncertainError(
          "Workspace upload completion lock release was not confirmed",
        )
      }
      if (!outcome.ok) throw outcome.error
      return outcome.value
    },
    "fenceWorkspaceUploadCompletion",
    { deadlineMs: timeoutMs },
  )
}

async function reconstructCommittedPrivateUpload(
  reservation: WorkspaceUploadReservation,
  signedWorkspacePrefix: string,
): Promise<CompletedWorkspaceUpload> {
  if (!reservation.objectVersionId) {
    throw new WorkspaceStorageCompletionError(
      "Committed workspace upload has no verified object version",
    )
  }
  const prefix = `${validateTrustedPrefix(signedWorkspacePrefix)}/`
  if (
    reservation.publicArtifact ||
    !reservation.targetKey.startsWith(prefix)
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace upload target does not match its signed prefix",
    )
  }
  const relativePath = reservation.targetKey.slice(prefix.length)
  if (!isCheckpointManagedWorkspacePath(relativePath)) {
    throw new WorkspaceStorageCompletionError(
      "Workspace upload target is not mutable user state",
    )
  }
  const eTag = await committedUploadMatches(
    reservation.targetKey,
    reservation.objectVersionId,
    reservation.expectedBytes,
    reservation.checksumSha256,
    reservation.contentType,
  )
  if (!eTag) {
    throw new WorkspaceStorageCompletionError(
      "Committed workspace upload is no longer the current object",
    )
  }
  const snapshot = await readWorkspaceGenerationSnapshot(
    signedWorkspacePrefix,
  )
  const listed = snapshot.entries.get(relativePath)
  if (
    !listed ||
    listed.size !== reservation.expectedBytes ||
    listed.eTag !== eTag
  ) {
    throw new WorkspaceStorageCompletionError(
      "Committed workspace generation could not be reconstructed",
    )
  }
  return {
    key: reservation.targetKey,
    eTag,
    workspaceGeneration: snapshot.generation,
  }
}

// Recovery keeps every verification/settlement guard in one auditable boundary.
// eslint-disable-next-line complexity
async function recoverVerifyingPrivateUpload(
  reservation: WorkspaceUploadReservation,
  signedWorkspacePrefix: string,
  database: UnretriedDatabaseSession,
): Promise<CompletedWorkspaceUpload> {
  const prefix = `${validateTrustedPrefix(signedWorkspacePrefix)}/`
  if (
    reservation.publicArtifact ||
    !reservation.targetKey.startsWith(prefix)
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace upload target does not match its signed prefix",
    )
  }
  const relativePath = reservation.targetKey.slice(prefix.length)
  if (!isCheckpointManagedWorkspacePath(relativePath)) {
    throw new WorkspaceStorageCompletionError(
      "Workspace upload target is not mutable user state",
    )
  }
  let metadata
  try {
    metadata = await s3Client().send(
      new HeadObjectCommand({
        Bucket: bucketName(),
        Key: reservation.targetKey,
        ChecksumMode: "ENABLED",
      }),
    )
  } catch (error) {
    if (!isS3ObjectNotFound(error)) throw error
    await resetWorkspaceUploadClaim(reservation.id, database)
    throw new WorkspaceStorageCompletionError(
      "Workspace upload claim was returned for staged retry",
    )
  }
  const eTag =
    typeof metadata.ETag === "string" && metadata.ETag.length > 0
      ? metadata.ETag
      : undefined
  const versionId =
    typeof metadata.VersionId === "string" &&
    metadata.VersionId.length > 0
      ? metadata.VersionId
      : undefined
  const targetMatches =
    metadata.ContentLength === reservation.expectedBytes &&
    metadata.ChecksumSHA256 === reservation.checksumSha256 &&
    metadata.ContentType === reservation.contentType &&
    eTag !== undefined &&
    versionId !== undefined
  if (!targetMatches || !eTag || !versionId) {
    await resetWorkspaceUploadClaim(reservation.id, database)
    throw new WorkspaceStorageCompletionError(
      "Workspace upload claim was returned for staged retry",
    )
  }
  const snapshot = await readWorkspaceGenerationSnapshot(
    signedWorkspacePrefix,
  )
  const listed = snapshot.entries.get(relativePath)
  if (
    !listed ||
    listed.size !== reservation.expectedBytes ||
    listed.eTag !== eTag
  ) {
    throw new WorkspaceStorageSettlementUncertainError(
      "Verifying workspace upload generation is not yet authoritative",
    )
  }
  const priorVersions = await supersededUploadVersions(
    reservation.ownerKey,
    reservation.targetKey,
    database,
  )
  await settleUploadReservation(
    reservation.id,
    versionId,
    priorVersions.map((prior) => prior.id),
    database,
  )
  return {
    key: reservation.targetKey,
    eTag,
    workspaceGeneration: snapshot.generation,
  }
}

async function inspectStagedUpload(
  claimed: WorkspaceUploadReservation,
  bucket: string,
): Promise<{ versionId: string | undefined; matches: boolean }> {
  const metadata = await s3Client().send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: claimed.stagingKey,
      ChecksumMode: "ENABLED",
    }),
  )
  return {
    versionId: metadata.VersionId,
    matches:
      metadata.ContentLength === claimed.expectedBytes &&
      metadata.ChecksumSHA256 === claimed.checksumSha256 &&
      metadata.ContentType === claimed.contentType &&
      Boolean(metadata.VersionId),
  }
}

async function supersededUploadVersions(
  ownerKey: string,
  targetKey: string,
  database: UnretriedDatabaseSession = defaultDatabaseExecutor,
): Promise<Array<{ id: string; objectVersionId: string | null }>> {
  return database.executeQuery(
    (db) =>
      db
        .select({
          id: workspaceUploadReservations.id,
          objectVersionId: workspaceUploadReservations.objectVersionId,
        })
        .from(workspaceUploadReservations)
        .where(
          and(
            eq(workspaceUploadReservations.ownerKey, ownerKey),
            eq(workspaceUploadReservations.targetKey, targetKey),
            eq(workspaceUploadReservations.status, "committed"),
          ),
        ),
    "getSupersededWorkspaceUploadVersions",
  )
}

async function copyStagedUpload(
  claimed: WorkspaceUploadReservation,
  bucket: string,
  stagingVersion: string,
): Promise<{ versionId: string; eTag?: string }> {
  const copied = await s3Client().send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: claimed.targetKey,
      CopySource: `${bucket}/${claimed.stagingKey
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?versionId=${encodeURIComponent(stagingVersion)}`,
      ChecksumAlgorithm: "SHA256",
      ContentType: claimed.contentType,
      MetadataDirective: "REPLACE",
      Tagging: `Scope=${claimed.publicArtifact ? "public" : "private"}`,
      TaggingDirective: "REPLACE",
    }),
  )
  if (!copied.VersionId) {
    throw new WorkspaceStorageCompletionError(
      "Verified upload promotion returned no object version",
    )
  }
  return {
    versionId: copied.VersionId,
    ...(copied.CopyObjectResult?.ETag
      ? { eTag: copied.CopyObjectResult.ETag }
      : {}),
  }
}

async function settleUploadReservation(
  reservationId: string,
  promotedVersion: string,
  supersededReservationIds: readonly string[] = [],
  database: UnretriedDatabaseSession = defaultDatabaseExecutor,
): Promise<void> {
  let settlementError: unknown
  try {
    const settledRow = await database.executeTransaction(
      async (tx) => {
        const [row] = await tx
          .update(workspaceUploadReservations)
          .set({
            status: "committed",
            objectVersionId: promotedVersion,
            committedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(workspaceUploadReservations.id, reservationId),
              eq(workspaceUploadReservations.status, "verifying"),
            ),
          )
          .returning({ id: workspaceUploadReservations.id })
        if (row && supersededReservationIds.length > 0) {
          const supersededRows = await tx
            .update(workspaceUploadReservations)
            .set({ status: "superseded", updatedAt: new Date() })
            .where(
              and(
                inArray(
                  workspaceUploadReservations.id,
                  [...supersededReservationIds],
                ),
                eq(workspaceUploadReservations.status, "committed"),
              ),
            )
            .returning({ id: workspaceUploadReservations.id })
          const supersededIds = new Set(
            supersededRows.map((superseded) => superseded.id),
          )
          if (
            !supersededReservationIds.every((id) =>
              supersededIds.has(id),
            )
          ) {
            throw new WorkspaceStorageCompletionError(
              "Superseded workspace quota settlement was incomplete",
            )
          }
        }
        return row
      },
      "settleWorkspaceUploadCompletion",
    )
    if (settledRow) return
    settlementError = new WorkspaceStorageCompletionError(
      "Upload reservation settlement was lost",
    )
  } catch (error) {
    settlementError = error
  }
  try {
    const [committed] = await database.executeQuery(
      (db) =>
        db
          .select({
            status: workspaceUploadReservations.status,
            objectVersionId:
              workspaceUploadReservations.objectVersionId,
          })
          .from(workspaceUploadReservations)
          .where(eq(workspaceUploadReservations.id, reservationId))
          .limit(1),
      "confirmWorkspaceUploadSettlement",
    )
    if (
      committed?.status === "committed" &&
      committed.objectVersionId === promotedVersion
    ) {
      if (supersededReservationIds.length > 0) {
        const superseded = await database.executeQuery(
          (db) =>
            db
              .select({
                id: workspaceUploadReservations.id,
                status: workspaceUploadReservations.status,
              })
              .from(workspaceUploadReservations)
              .where(
                inArray(
                  workspaceUploadReservations.id,
                  [...supersededReservationIds],
                ),
              ),
          "confirmSupersededWorkspaceUploadSettlement",
        )
        const settledIds = new Set(
          superseded
            .filter((row) => row.status === "superseded")
            .map((row) => row.id),
        )
        if (
          supersededReservationIds.every((id) => settledIds.has(id))
        ) {
          return
        }
        throw new WorkspaceStorageSettlementUncertainError(
          "Superseded workspace quota settlement could not be confirmed",
        )
      }
      return
    }
  } catch (error) {
    if (error instanceof WorkspaceStorageSettlementUncertainError) {
      throw error
    }
    throw new WorkspaceStorageSettlementUncertainError(
      "Upload reservation settlement could not be confirmed",
    )
  }
  throw settlementError
}

async function removeSupersededVersions(
  priorVersions: Array<{ id: string; objectVersionId: string | null }>,
  targetKey: string,
  bucket: string,
): Promise<void> {
  for (const prior of priorVersions) {
    if (!prior.objectVersionId) continue
    try {
      await s3Client().send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: targetKey,
          VersionId: prior.objectVersionId,
        }),
      )
      await executeQuery(
        (db) =>
          db
            .update(workspaceUploadReservations)
            .set({ status: "superseded", updatedAt: new Date() })
            .where(
              and(
                eq(workspaceUploadReservations.id, prior.id),
                eq(workspaceUploadReservations.status, "committed"),
              ),
            ),
        "settleSupersededWorkspaceUploadVersion",
      )
    } catch {
      // Leave the old row committed and charged until exact-version cleanup
      // succeeds on a later replacement/reconciliation attempt.
    }
  }
}

interface FailedUploadCleanup {
  claimed: WorkspaceUploadReservation
  reservationId: string
  bucket: string
  stagingVersion: string | undefined
  promotedVersion: string | undefined
  error: unknown
  database: UnretriedDatabaseSession
  onCapacityRelease: () => void
}

async function rejectFailedUpload({
  claimed,
  reservationId,
  bucket,
  stagingVersion,
  promotedVersion,
  error,
  database,
  onCapacityRelease,
}: FailedUploadCleanup): Promise<never> {
  let cleanupFailed = false
  for (const [key, versionId] of [
    [claimed.targetKey, promotedVersion],
    [claimed.stagingKey, stagingVersion],
  ] as const) {
    if (!versionId) continue
    try {
      await s3Client().send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
      )
    } catch {
      cleanupFailed = true
    }
  }
  if (cleanupFailed) {
    throw new WorkspaceStorageCompletionError(
      "Upload cleanup is pending; reserved capacity remains charged",
    )
  }
  await database.executeQuery(
    (db) =>
      db
        .update(workspaceUploadReservations)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(
          and(
            eq(workspaceUploadReservations.id, reservationId),
            eq(workspaceUploadReservations.status, "verifying"),
          ),
        ),
    "rejectWorkspaceUploadCompletion",
  )
  onCapacityRelease()
  throw error
}

async function resetWorkspaceUploadClaim(
  reservationId: string,
  database: UnretriedDatabaseSession,
): Promise<void> {
  const [reset] = await database.executeQuery(
    (db) =>
      db
        .update(workspaceUploadReservations)
        .set({ status: "reserved", updatedAt: new Date() })
        .where(
          and(
            eq(workspaceUploadReservations.id, reservationId),
            eq(workspaceUploadReservations.status, "verifying"),
          ),
        )
        .returning({ id: workspaceUploadReservations.id }),
    "resetWorkspaceUploadCompletionClaim",
  )
  if (!reset) {
    throw new WorkspaceStorageSettlementUncertainError(
      "Workspace upload claim could not be returned for retry",
    )
  }
}

// Promotion is one transaction-like boundary; splitting it obscures cleanup state.
// eslint-disable-next-line max-lines-per-function, max-params, complexity
async function finishClaimedUpload(
  claimed: WorkspaceUploadReservation,
  ownerKey: string,
  reservationId: string,
  database: UnretriedDatabaseSession,
  onCapacityRelease: () => void,
  generationFence?: {
    signedWorkspacePrefix: string
    expectedGeneration: string
    snapshot?: WorkspaceGenerationSnapshot
    checkpointAlreadyAnchored?: boolean
  },
): Promise<CompletedWorkspaceUpload> {
  const bucket = bucketName()
  let stagingVersion: string | undefined
  let promotedVersion: string | undefined
  let settled = false
  let promotionAttempted = false
  let generationChecked = generationFence === undefined
  let stagingVerified = false
  let generationSnapshot: WorkspaceGenerationSnapshot | undefined
  let targetRelativePath: string | undefined
  try {
    const staged = await inspectStagedUpload(claimed, bucket)
    stagingVersion = staged.versionId
    if (!staged.matches || !stagingVersion) {
      throw new WorkspaceStorageCompletionError(
        "Uploaded object did not match its reservation",
      )
    }
    stagingVerified = true
    if (generationFence) {
      const prefix = `${validateTrustedPrefix(
        generationFence.signedWorkspacePrefix,
      )}/`
      if (
        !claimed.targetKey.startsWith(prefix) ||
        claimed.publicArtifact
      ) {
        throw new WorkspaceStorageCompletionError(
          "Workspace upload target does not match its signed prefix",
        )
      }
      targetRelativePath = claimed.targetKey.slice(prefix.length)
      if (!isCheckpointManagedWorkspacePath(targetRelativePath)) {
        throw new WorkspaceStorageCompletionError(
          "Workspace upload target is not mutable user state",
        )
      }
      generationSnapshot =
        generationFence.snapshot ??
        await readWorkspaceGenerationSnapshot(
          generationFence.signedWorkspacePrefix,
        )
      if (
        generationSnapshot.generation !==
        generationFence.expectedGeneration
      ) {
        throw new WorkspaceStorageCompletionError(
          "Workspace generation changed before upload promotion",
        )
      }
      generationChecked = true
      if (!generationFence.checkpointAlreadyAnchored) {
        await anchorCommittedCheckpointPathBeforePromotion(
          generationFence.signedWorkspacePrefix,
          targetRelativePath,
        )
      }
    }
    const priorVersions = await supersededUploadVersions(
      ownerKey,
      claimed.targetKey,
      database,
    )
    promotionAttempted = true
    const promoted = await copyStagedUpload(
      claimed,
      bucket,
      stagingVersion,
    )
    promotedVersion = promoted.versionId
    if (generationFence && !promoted.eTag) {
      throw new WorkspaceStorageCompletionError(
        "Verified workspace promotion returned no ETag",
      )
    }
    await s3Client().send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: claimed.stagingKey,
        VersionId: stagingVersion,
      }),
    )
    await settleUploadReservation(
      reservationId,
      promotedVersion,
      generationFence ? priorVersions.map((prior) => prior.id) : [],
      database,
    )
    settled = true
    if (!generationFence) {
      await removeSupersededVersions(
        priorVersions,
        claimed.targetKey,
        bucket,
      )
    }
    let workspaceGeneration: string | undefined
    if (
      generationFence &&
      generationSnapshot &&
      targetRelativePath
    ) {
      generationSnapshot.entries.set(targetRelativePath, {
        path: targetRelativePath,
        size: claimed.expectedBytes,
        eTag: promoted.eTag!,
      })
      workspaceGeneration = workspaceGenerationFromEntries(
        [...generationSnapshot.entries.values()],
      )
      generationSnapshot.generation = workspaceGeneration
    }
    return {
      key: claimed.targetKey,
      ...(generationFence
        ? {
            eTag: promoted.eTag,
            workspaceGeneration,
          }
        : {}),
      ...(claimed.publicArtifact
        ? { publicUrl: publicUrl(bucket, claimed.targetKey) }
        : {}),
    }
  } catch (error) {
    // A missing/mismatched generation is discovered after verifying staging
    // but before promotion. Return the reservation to a retryable state while
    // leaving both staging and target objects byte-for-byte untouched.
    if (
      generationFence &&
      stagingVerified &&
      !generationChecked
    ) {
      await resetWorkspaceUploadClaim(reservationId, database)
      throw error
    }
    if (
      settled ||
      (generationFence && promotionAttempted) ||
      error instanceof WorkspaceStorageSettlementUncertainError
    ) {
      throw error
    }
    return rejectFailedUpload({
      claimed,
      reservationId,
      bucket,
      stagingVersion,
      promotedVersion,
      error,
      database,
      onCapacityRelease,
    })
  }
}

export type FinalizeWorkspaceCheckpointResult = {
  checkpointCommitted: true
  workspaceGeneration: string
  uploads: Array<{
    reservationId: string
    key: string
    eTag: string
  }>
  deletions: Array<{
    path: string
    deleted: boolean
  }>
}

type WorkspaceFinalizationJournalRequest = {
  ownerHash: string
  signedWorkspacePrefix: string
  baseWorkspaceGeneration: string
  proofHash: string
  reservationIds: string[]
  deletedPaths: string[]
  requestDigest: string
}

type PendingWorkspaceFinalizationJournal =
  WorkspaceFinalizationJournalRequest & {
    version: 1
    state: "pending"
  }

type PreparedWorkspaceFinalizationJournal =
  WorkspaceFinalizationJournalRequest & {
    version: 1
    state: "prepared" | "committed"
    baseManifestDigest: string
    result: FinalizeWorkspaceCheckpointResult
    nextManifest: WorkspaceCheckpointManifest
  }

type WorkspaceFinalizationJournal =
  | PendingWorkspaceFinalizationJournal
  | PreparedWorkspaceFinalizationJournal

function workspaceFinalizationJournalKey(
  signedWorkspacePrefix: string,
): string {
  return `${checkpointNamespace(signedWorkspacePrefix)}/last-finalization.json`
}

function workspaceFinalizationOwnerHash(ownerKey: string): string {
  return createHash("sha256").update(ownerKey).digest("hex")
}

function workspaceFinalizationProofHash(proof: string): string {
  return createHash("sha256").update(proof).digest("hex")
}

function workspaceFinalizationRequestDigest(
  request: Omit<WorkspaceFinalizationJournalRequest, "requestDigest">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        ownerHash: request.ownerHash,
        signedWorkspacePrefix: request.signedWorkspacePrefix,
        baseWorkspaceGeneration: request.baseWorkspaceGeneration,
        proofHash: request.proofHash,
        reservationIds: request.reservationIds,
        deletedPaths: request.deletedPaths,
      }),
    )
    .digest("hex")
}

function workspaceCheckpointManifestDigest(
  manifest: WorkspaceCheckpointManifest,
): string {
  return createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex")
}

function createWorkspaceFinalizationJournalRequest(options: {
  ownerKey: string
  signedWorkspacePrefix: string
  baseWorkspaceGeneration: string
  proof: string
  reservationIds: readonly string[]
  deletedPaths: readonly string[]
}): WorkspaceFinalizationJournalRequest {
  const requestWithoutDigest = {
    ownerHash: workspaceFinalizationOwnerHash(options.ownerKey),
    signedWorkspacePrefix: options.signedWorkspacePrefix,
    baseWorkspaceGeneration: options.baseWorkspaceGeneration,
    proofHash: workspaceFinalizationProofHash(options.proof),
    reservationIds: [...options.reservationIds],
    deletedPaths: [...options.deletedPaths],
  }
  return {
    ...requestWithoutDigest,
    requestDigest: workspaceFinalizationRequestDigest(
      requestWithoutDigest,
    ),
  }
}

function isExactRecord(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  )
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  )
}

function workspaceFinalizationRequestsEqual(
  left: WorkspaceFinalizationJournalRequest,
  right: WorkspaceFinalizationJournalRequest,
): boolean {
  return (
    left.ownerHash === right.ownerHash &&
    left.signedWorkspacePrefix === right.signedWorkspacePrefix &&
    left.baseWorkspaceGeneration === right.baseWorkspaceGeneration &&
    left.proofHash === right.proofHash &&
    left.requestDigest === right.requestDigest &&
    stringArraysEqual(left.reservationIds, right.reservationIds) &&
    stringArraysEqual(left.deletedPaths, right.deletedPaths)
  )
}

function parseWorkspaceFinalizationStringArray(
  value: unknown,
  validate: (item: string) => boolean,
): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > MAX_WORKSPACE_GENERATION_OBJECTS
  ) {
    return null
  }
  const items: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== "string" || !validate(candidate)) return null
    if (seen.has(candidate)) return null
    seen.add(candidate)
    items.push(candidate)
  }
  return items
}

// A persisted result is hostile input; every nested field is validated.
// eslint-disable-next-line complexity
function parseWorkspaceFinalizationResult(
  value: unknown,
  signedWorkspacePrefix: string,
  reservationIds: readonly string[],
  deletedPaths: readonly string[],
): FinalizeWorkspaceCheckpointResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  const candidate = value as Record<string, unknown>
  if (
    !isExactRecord(candidate, [
      "checkpointCommitted",
      "workspaceGeneration",
      "uploads",
      "deletions",
    ]) ||
    candidate.checkpointCommitted !== true ||
    typeof candidate.workspaceGeneration !== "string" ||
    !WORKSPACE_GENERATION_RE.test(candidate.workspaceGeneration) ||
    !Array.isArray(candidate.uploads) ||
    candidate.uploads.length !== reservationIds.length ||
    !Array.isArray(candidate.deletions) ||
    candidate.deletions.length !== deletedPaths.length
  ) {
    return null
  }

  const uploads: FinalizeWorkspaceCheckpointResult["uploads"] = []
  for (let index = 0; index < candidate.uploads.length; index += 1) {
    const raw = candidate.uploads[index]
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const upload = raw as Record<string, unknown>
    if (
      !isExactRecord(upload, ["reservationId", "key", "eTag"]) ||
      upload.reservationId !== reservationIds[index] ||
      typeof upload.key !== "string" ||
      !upload.key.startsWith(`${signedWorkspacePrefix}/`) ||
      typeof upload.eTag !== "string" ||
      upload.eTag.length === 0 ||
      upload.eTag.length > 1_024
    ) {
      return null
    }
    const relativePath = upload.key.slice(signedWorkspacePrefix.length + 1)
    if (
      !isCheckpointManagedWorkspacePath(relativePath) ||
      ownerWorkspaceKey(signedWorkspacePrefix, relativePath) !== upload.key
    ) {
      return null
    }
    uploads.push({
      reservationId: upload.reservationId,
      key: upload.key,
      eTag: upload.eTag,
    })
  }

  const deletions: FinalizeWorkspaceCheckpointResult["deletions"] = []
  for (let index = 0; index < candidate.deletions.length; index += 1) {
    const raw = candidate.deletions[index]
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const deletion = raw as Record<string, unknown>
    if (
      !isExactRecord(deletion, ["path", "deleted"]) ||
      deletion.path !== deletedPaths[index] ||
      typeof deletion.deleted !== "boolean"
    ) {
      return null
    }
    deletions.push({
      path: deletion.path,
      deleted: deletion.deleted,
    })
  }
  return {
    checkpointCommitted: true,
    workspaceGeneration: candidate.workspaceGeneration,
    uploads,
    deletions,
  }
}

// Persisted control state is treated as hostile until every field is checked.
// eslint-disable-next-line complexity
function parseWorkspaceFinalizationJournal(
  value: unknown,
  signedWorkspacePrefix: string,
): WorkspaceFinalizationJournal {
  const invalid = (): never => {
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization journal is invalid",
    )
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid()
  }
  const candidate = value as Record<string, unknown>
  const commonFields = [
    "version",
    "state",
    "ownerHash",
    "signedWorkspacePrefix",
    "baseWorkspaceGeneration",
    "proofHash",
    "reservationIds",
    "deletedPaths",
    "requestDigest",
  ] as const
  const prepared =
    candidate.state === "prepared" || candidate.state === "committed"
  if (
    !isExactRecord(
      candidate,
      prepared
        ? [
            ...commonFields,
            "baseManifestDigest",
            "result",
            "nextManifest",
          ]
        : commonFields,
    ) ||
    candidate.version !== 1 ||
    (candidate.state !== "pending" && !prepared) ||
    typeof candidate.ownerHash !== "string" ||
    !WORKSPACE_GENERATION_RE.test(candidate.ownerHash) ||
    candidate.signedWorkspacePrefix !== signedWorkspacePrefix ||
    typeof candidate.baseWorkspaceGeneration !== "string" ||
    !WORKSPACE_GENERATION_RE.test(candidate.baseWorkspaceGeneration) ||
    typeof candidate.proofHash !== "string" ||
    !WORKSPACE_GENERATION_RE.test(candidate.proofHash) ||
    typeof candidate.requestDigest !== "string" ||
    !WORKSPACE_GENERATION_RE.test(candidate.requestDigest)
  ) {
    return invalid()
  }
  const reservationIds = parseWorkspaceFinalizationStringArray(
    candidate.reservationIds,
    (item) => WORKSPACE_RESERVATION_ID_RE.test(item),
  )
  const deletedPaths = parseWorkspaceFinalizationStringArray(
    candidate.deletedPaths,
    (item) => {
      try {
        return (
          validateWorkspaceRelativePath(item) === item &&
          isCheckpointManagedWorkspacePath(item)
        )
      } catch {
        return false
      }
    },
  )
  if (
    !reservationIds ||
    !deletedPaths ||
    reservationIds.length + deletedPaths.length >
      MAX_WORKSPACE_GENERATION_OBJECTS
  ) {
    return invalid()
  }
  const request = {
    ownerHash: candidate.ownerHash,
    signedWorkspacePrefix,
    baseWorkspaceGeneration: candidate.baseWorkspaceGeneration,
    proofHash: candidate.proofHash,
    reservationIds,
    deletedPaths,
  }
  if (
    workspaceFinalizationRequestDigest(request) !== candidate.requestDigest
  ) {
    return invalid()
  }
  const base: WorkspaceFinalizationJournalRequest = {
    ...request,
    requestDigest: candidate.requestDigest,
  }
  if (!prepared) {
    return { version: 1, state: "pending", ...base }
  }
  const result = parseWorkspaceFinalizationResult(
    candidate.result,
    signedWorkspacePrefix,
    reservationIds,
    deletedPaths,
  )
  if (!result) return invalid()
  if (
    typeof candidate.baseManifestDigest !== "string" ||
    !WORKSPACE_GENERATION_RE.test(candidate.baseManifestDigest)
  ) {
    return invalid()
  }
  const nextManifest = parseWorkspaceCheckpointManifest(
    candidate.nextManifest,
    signedWorkspacePrefix,
  ).manifest
  if (nextManifest.workspaceGeneration !== result.workspaceGeneration) {
    return invalid()
  }
  return {
    version: 1,
    state: candidate.state as "prepared" | "committed",
    ...base,
    baseManifestDigest: candidate.baseManifestDigest,
    result,
    nextManifest,
  }
}

async function readWorkspaceFinalizationJournal(
  signedWorkspacePrefix: string,
): Promise<WorkspaceFinalizationJournal | null> {
  let response
  try {
    response = await s3Client().send(
      new GetObjectCommand({
        Bucket: bucketName(),
        Key: workspaceFinalizationJournalKey(signedWorkspacePrefix),
      }),
    )
  } catch (error) {
    if (isS3ObjectNotFound(error)) return null
    throw error
  }
  if (
    !Number.isSafeInteger(response.ContentLength) ||
    !response.ContentLength ||
    response.ContentLength > MAX_WORKSPACE_FINALIZATION_JOURNAL_BYTES ||
    !response.Body
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization journal is invalid",
    )
  }
  const serialized = await response.Body.transformToString("utf-8")
  if (Buffer.byteLength(serialized, "utf8") !== response.ContentLength) {
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization journal is invalid",
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization journal is invalid",
    )
  }
  return parseWorkspaceFinalizationJournal(parsed, signedWorkspacePrefix)
}

async function writeWorkspaceFinalizationJournal(
  journal: WorkspaceFinalizationJournal,
): Promise<void> {
  const serialized = JSON.stringify(journal)
  const contentLength = Buffer.byteLength(serialized, "utf8")
  if (
    contentLength === 0 ||
    contentLength > MAX_WORKSPACE_FINALIZATION_JOURNAL_BYTES
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace finalization journal exceeds its size backstop",
    )
  }
  try {
    const written = await s3Client().send(
      new PutObjectCommand({
        Bucket: bucketName(),
        Key: workspaceFinalizationJournalKey(
          journal.signedWorkspacePrefix,
        ),
        Body: serialized,
        ContentLength: contentLength,
        ContentType: "application/json",
        Tagging: "Scope=checkpoint",
      }),
    )
    if (!written.VersionId) {
      throw new WorkspaceStorageCompletionError(
        "Workspace finalization journal returned no object version",
      )
    }
  } catch (error) {
    // S3 PutObject can commit durably while its HTTP response is lost. The
    // stable versioned journal key is strongly consistent, so an exact
    // read-after-error makes each phase transition safely idempotent.
    let persisted: WorkspaceFinalizationJournal | null
    try {
      persisted = await readWorkspaceFinalizationJournal(
        journal.signedWorkspacePrefix,
      )
    } catch {
      throw error
    }
    if (
      persisted &&
      workspaceFinalizationJournalsEqual(persisted, journal)
    ) {
      return
    }
    throw error
  }
}

function workspaceFinalizationResultsEqual(
  left: FinalizeWorkspaceCheckpointResult,
  right: FinalizeWorkspaceCheckpointResult,
): boolean {
  return (
    left.checkpointCommitted === right.checkpointCommitted &&
    left.workspaceGeneration === right.workspaceGeneration &&
    left.uploads.length === right.uploads.length &&
    left.uploads.every((upload, index) => {
      const candidate = right.uploads[index]
      return (
        candidate !== undefined &&
        upload.reservationId === candidate.reservationId &&
        upload.key === candidate.key &&
        upload.eTag === candidate.eTag
      )
    }) &&
    left.deletions.length === right.deletions.length &&
    left.deletions.every((deletion, index) => {
      const candidate = right.deletions[index]
      return (
        candidate !== undefined &&
        deletion.path === candidate.path &&
        deletion.deleted === candidate.deleted
      )
    })
  )
}

function workspaceCheckpointManifestsEqual(
  left: WorkspaceCheckpointManifest,
  right: WorkspaceCheckpointManifest,
): boolean {
  if (
    left.version !== right.version ||
    left.signedWorkspacePrefix !== right.signedWorkspacePrefix ||
    left.workspaceGeneration !== right.workspaceGeneration ||
    left.entries.length !== right.entries.length
  ) return false
  return left.entries.every((entry, index) => {
    const candidate = right.entries[index]
    return (
      candidate !== undefined &&
      entry.path === candidate.path &&
      entry.size === candidate.size &&
      entry.eTag === candidate.eTag &&
      entry.source === candidate.source &&
      entry.versionId === candidate.versionId &&
      entry.sourceETag === candidate.sourceETag
    )
  })
}

function workspaceFinalizationJournalsEqual(
  left: WorkspaceFinalizationJournal,
  right: WorkspaceFinalizationJournal,
): boolean {
  if (
    left.version !== right.version ||
    left.state !== right.state ||
    !workspaceFinalizationRequestsEqual(left, right)
  ) {
    return false
  }
  if (left.state === "pending" || right.state === "pending") {
    return left.state === right.state
  }
  return (
    left.baseManifestDigest === right.baseManifestDigest &&
    workspaceFinalizationResultsEqual(left.result, right.result) &&
    workspaceCheckpointManifestsEqual(
      left.nextManifest,
      right.nextManifest,
    )
  )
}

async function verifyPreparedWorkspaceFinalizationTargets(
  journal: PreparedWorkspaceFinalizationJournal,
): Promise<void> {
  const finalEntries = new Map(
    journal.nextManifest.entries.map((entry) => [entry.path, entry]),
  )
  for (const upload of journal.result.uploads) {
    const path = upload.key.slice(journal.signedWorkspacePrefix.length + 1)
    const entry = finalEntries.get(path)
    if (!entry || entry.eTag !== upload.eTag) {
      throw new WorkspaceStorageCompletionError(
        "Prepared workspace finalization upload is invalid",
      )
    }
    const current = await s3Client().send(
      new HeadObjectCommand({
        Bucket: bucketName(),
        Key: upload.key,
      }),
    )
    if (
      current.ContentLength !== entry.size ||
      current.ETag !== entry.eTag ||
      current.VersionId !== entry.versionId
    ) {
      throw new WorkspaceStorageCompletionError(
        "Prepared workspace finalization target changed",
      )
    }
  }
  for (const deletion of journal.result.deletions) {
    if (!deletion.deleted) continue
    try {
      await s3Client().send(
        new HeadObjectCommand({
          Bucket: bucketName(),
          Key: ownerWorkspaceKey(
            journal.signedWorkspacePrefix,
            deletion.path,
          ),
        }),
      )
    } catch (error) {
      if (isS3ObjectNotFound(error)) continue
      throw error
    }
    throw new WorkspaceStorageCompletionError(
      "Prepared workspace finalization deletion changed",
    )
  }
}

/**
 * Publish every turn-final workspace mutation behind one generation fence.
 *
 * `ensureWorkspaceCheckpoint` already performed the authoritative full S3
 * scan after the Router acquired the owner-wide lease. Its signed proof lets
 * this operation seed the batch from the exact committed manifest instead of
 * repeating that same scan once per changed SQLite file. The manifest Put
 * below remains the single commit point; exact-version anchors are durable
 * before the first target mutation, so the ordinary ensure path can recover a
 * crash-partial batch without losing the prior checkpoint.
 */
// The explicit phases keep the fail-closed boundary auditable in one place.
// eslint-disable-next-line max-lines-per-function, max-params
export async function finalizeWorkspaceCheckpoint(
  ownerEmail: string,
  signedWorkspacePrefix: string,
  baseWorkspaceGeneration: string,
  reservationIds: readonly string[],
  deletedPaths: readonly string[],
  checkpointFinalizationProof: string,
  invocationNonce: string,
  invocationExpiresAt: number,
): Promise<FinalizeWorkspaceCheckpointResult> {
  const prefix = validateTrustedPrefix(signedWorkspacePrefix)
  const ownerKey = ownerEmail.trim().toLowerCase()
  if (
    !WORKSPACE_GENERATION_RE.test(baseWorkspaceGeneration) ||
    !invocationNonce ||
    !Number.isInteger(invocationExpiresAt) ||
    reservationIds.length + deletedPaths.length >
      MAX_WORKSPACE_GENERATION_OBJECTS
  ) {
    throw new Error("Invalid workspace checkpoint batch")
  }
  const normalizedReservationIds = reservationIds.map((id) => {
    if (!WORKSPACE_RESERVATION_ID_RE.test(id)) {
      throw new Error("Invalid workspace checkpoint batch")
    }
    return id.toLowerCase()
  })
  if (
    new Set(normalizedReservationIds.map((id) => id.toLowerCase()))
      .size !== normalizedReservationIds.length
  ) {
    throw new Error("Invalid workspace checkpoint batch")
  }
  const normalizedDeletedPaths = deletedPaths.map((path) => {
    const normalized = validateWorkspaceRelativePath(path)
    if (!isCheckpointManagedWorkspacePath(normalized)) {
      throw new Error("Invalid workspace checkpoint batch")
    }
    return normalized
  })
  if (new Set(normalizedDeletedPaths).size !== normalizedDeletedPaths.length) {
    throw new Error("Invalid workspace checkpoint batch")
  }
  const journalRequest = createWorkspaceFinalizationJournalRequest({
    ownerKey,
    signedWorkspacePrefix: prefix,
    baseWorkspaceGeneration,
    proof: checkpointFinalizationProof,
    reservationIds: normalizedReservationIds,
    deletedPaths: normalizedDeletedPaths,
  })
  const leasesToDrop: WorkspaceUploadReservation[] = []
  try {
    return await withWorkspaceGenerationLock(
      prefix,
      // All mutation phases stay inside one owner-wide generation fence.
      // eslint-disable-next-line max-lines-per-function, complexity
      async (database) => {
        let manifest = await readWorkspaceCheckpointManifest(prefix)
        const existingJournal = await readWorkspaceFinalizationJournal(
          prefix,
        )
        if (
          existingJournal &&
          workspaceFinalizationRequestsEqual(
            existingJournal,
            journalRequest,
          )
        ) {
          if (existingJournal.state !== "pending") {
            if (
              manifest &&
              workspaceCheckpointManifestsEqual(
                manifest,
                existingJournal.nextManifest,
              )
            ) {
              if (existingJournal.state === "prepared") {
                await writeWorkspaceFinalizationJournal({
                  ...existingJournal,
                  state: "committed",
                })
              }
              return existingJournal.result
            }
            if (
              existingJournal.state === "prepared" &&
              manifest &&
              workspaceCheckpointManifestDigest(manifest) ===
                existingJournal.baseManifestDigest
            ) {
              await verifyPreparedWorkspaceFinalizationTargets(
                existingJournal,
              )
              await writeWorkspaceCheckpointManifest(
                existingJournal.nextManifest,
              )
              await writeWorkspaceFinalizationJournal({
                ...existingJournal,
                state: "committed",
              })
              return existingJournal.result
            }
            throw new WorkspaceStorageCompletionError(
              "Workspace generation changed after checkpoint finalization",
            )
          }
        }
        await verifyWorkspaceFinalizationProof(
          checkpointFinalizationProof,
          {
            version: 1,
            signedWorkspacePrefix: prefix,
            workspaceGeneration: baseWorkspaceGeneration,
            invocationNonce,
            expiresAt: invocationExpiresAt,
          },
        )
        if (
          !manifest ||
          manifest.workspaceGeneration !== baseWorkspaceGeneration
        ) {
          throw new WorkspaceStorageCompletionError(
            "Workspace generation changed before checkpoint finalization",
          )
        }
        await writeWorkspaceFinalizationJournal({
          version: 1,
          state: "pending",
          ...journalRequest,
        })
        const snapshot: WorkspaceGenerationSnapshot = {
          generation: manifest.workspaceGeneration,
          entries: new Map(
            manifest.entries.map((entry) => [
              entry.path,
              {
                path: entry.path,
                size: entry.size,
                eTag: entry.eTag,
              },
            ]),
          ),
        }

        const claimed: WorkspaceUploadReservation[] = []
        try {
          for (const reservationId of normalizedReservationIds) {
            const claim = await claimUploadCompletion(
              ownerKey,
              reservationId,
              database,
              false,
              true,
            )
            if (claim.kind !== "claimed") {
              throw new WorkspaceStorageCompletionError(
                "Workspace checkpoint batch is not retryable",
              )
            }
            claimed.push(claim.reservation)
          }

          const uploadPaths = new Set<string>()
          for (const reservation of claimed) {
            const ownerPrefix = `${prefix}/`
            if (
              reservation.publicArtifact ||
              !reservation.targetKey.startsWith(ownerPrefix)
            ) {
              throw new WorkspaceStorageCompletionError(
                "Workspace upload target does not match its signed prefix",
              )
            }
            const relativePath = reservation.targetKey.slice(
              ownerPrefix.length,
            )
            if (
              !isCheckpointManagedWorkspacePath(relativePath) ||
              uploadPaths.has(relativePath) ||
              normalizedDeletedPaths.includes(relativePath)
            ) {
              throw new WorkspaceStorageCompletionError(
                "Workspace checkpoint batch contains conflicting paths",
              )
            }
            uploadPaths.add(relativePath)
            const staged = await inspectStagedUpload(
              reservation,
              bucketName(),
            )
            if (!staged.matches || !staged.versionId) {
              throw new WorkspaceStorageCompletionError(
                "Uploaded object did not match its reservation",
              )
            }
          }

          const plannedEntries = new Map(snapshot.entries)
          for (const path of normalizedDeletedPaths) {
            plannedEntries.delete(path)
          }
          for (const reservation of claimed) {
            const relativePath = reservation.targetKey.slice(
              prefix.length + 1,
            )
            plannedEntries.set(relativePath, {
              path: relativePath,
              size: reservation.expectedBytes,
              eTag: `pending-${reservation.id}`,
            })
          }
          assertPrefixFreeWorkspaceEntries([...plannedEntries.values()])
        } catch (error) {
          await Promise.allSettled(
            claimed.map((reservation) =>
              resetWorkspaceUploadClaim(reservation.id, database),
            ),
          )
          throw error
        }

        const mutationPaths = new Set(normalizedDeletedPaths)
        for (const reservation of claimed) {
          mutationPaths.add(
            reservation.targetKey.slice(prefix.length + 1),
          )
        }
        try {
          for (const path of mutationPaths) {
            await anchorCommittedCheckpointPathBeforePromotion(
              prefix,
              path,
            )
          }
          const anchoredManifest = await readWorkspaceCheckpointManifest(
            prefix,
          )
          if (
            !anchoredManifest ||
            anchoredManifest.workspaceGeneration !==
              baseWorkspaceGeneration
          ) {
            throw new WorkspaceStorageCompletionError(
              "Workspace checkpoint anchor generation changed",
            )
          }
          manifest = anchoredManifest
          const baseManifestDigest = workspaceCheckpointManifestDigest(
            anchoredManifest,
          )

          const deletions: FinalizeWorkspaceCheckpointResult["deletions"] = []
          for (const path of normalizedDeletedPaths) {
            const currentEntry = snapshot.entries.get(path)
            if (!currentEntry) {
              deletions.push({ path, deleted: false })
              continue
            }
            const committedEntry = manifest.entries.find(
              (entry) => entry.path === path,
            )
            if (
              !committedEntry ||
              committedEntry.size !== currentEntry.size ||
              committedEntry.eTag !== currentEntry.eTag
            ) {
              throw new WorkspaceStorageCompletionError(
                "Workspace delete target is not in the committed checkpoint",
              )
            }
            const deleted = await s3Client().send(
              new DeleteObjectCommand({
                Bucket: bucketName(),
                Key: ownerWorkspaceKey(prefix, path),
              }),
            )
            if (deleted.DeleteMarker !== true || !deleted.VersionId) {
              throw new WorkspaceStorageCompletionError(
                "Workspace path deletion was not version preserving",
              )
            }
            snapshot.entries.delete(path)
            snapshot.generation = workspaceGenerationFromEntries(
              [...snapshot.entries.values()],
            )
            deletions.push({ path, deleted: true })
          }

          const uploads: FinalizeWorkspaceCheckpointResult["uploads"] = []
          for (const [index, reservation] of claimed.entries()) {
            const completed = await finishClaimedUpload(
              reservation,
              ownerKey,
              reservation.id,
              database,
              () => {
                leasesToDrop.push(reservation)
              },
              {
                signedWorkspacePrefix: prefix,
                expectedGeneration: snapshot.generation,
                snapshot,
                checkpointAlreadyAnchored: true,
              },
            )
            if (!completed.eTag || !completed.workspaceGeneration) {
              throw new WorkspaceStorageCompletionError(
                "Workspace batch promotion returned incomplete metadata",
              )
            }
            uploads.push({
              reservationId: normalizedReservationIds[index]!,
              key: completed.key,
              eTag: completed.eTag,
            })
            await Promise.allSettled([
              settleLease(
                reservation.byteLeaseId,
                reservation.expectedBytes,
              ),
              settleLease(reservation.objectLeaseId, 1),
            ])
          }

          const nextManifest = await captureWorkspaceCheckpointManifest(
            prefix,
            snapshot,
            manifest,
          )
          if (nextManifest.workspaceGeneration !== snapshot.generation) {
            throw new WorkspaceStorageCompletionError(
              "Workspace checkpoint batch generation is incomplete",
            )
          }
          const result: FinalizeWorkspaceCheckpointResult = {
            checkpointCommitted: true,
            workspaceGeneration: nextManifest.workspaceGeneration,
            uploads,
            deletions,
          }
          const preparedJournal: PreparedWorkspaceFinalizationJournal = {
            version: 1,
            state: "prepared",
            ...journalRequest,
            baseManifestDigest,
            result,
            nextManifest,
          }
          await writeWorkspaceFinalizationJournal(preparedJournal)
          await writeWorkspaceCheckpointManifest(nextManifest)
          await writeWorkspaceFinalizationJournal({
            ...preparedJournal,
            state: "committed",
          })
          return result
        } catch (error) {
          await Promise.allSettled(
            claimed.map((reservation) =>
              resetWorkspaceUploadClaim(reservation.id, database),
            ),
          )
          throw error
        }
      },
    )
  } catch (error) {
    await Promise.allSettled(
      leasesToDrop.flatMap((reservation) => [
        dropLease(reservation.byteLeaseId),
        dropLease(reservation.objectLeaseId),
      ]),
    )
    throw error
  }
}

export async function completeWorkspaceUpload(
  ownerEmail: string,
  reservationId: string,
  signedWorkspacePrefix?: string,
  expectedGeneration?: string,
): Promise<CompletedWorkspaceUpload> {
  if (!/^[0-9a-f-]{36}$/i.test(reservationId)) {
    throw new Error("Invalid upload reservation")
  }
  const ownerKey = ownerEmail.trim().toLowerCase()
  let leaseReservation: WorkspaceUploadReservation | undefined
  let releaseCapacity = false
  const finishClaim = async (
    claim: Awaited<ReturnType<typeof claimUploadCompletion>>,
    database: UnretriedDatabaseSession,
    generationFence?: {
      signedWorkspacePrefix: string
      expectedGeneration: string
    },
  ): Promise<CompletedWorkspaceUpload> => {
    leaseReservation = claim.reservation
    if (claim.reservation.publicArtifact) {
      if (claim.kind === "committed") return claim.result
      return finishClaimedUpload(
        claim.reservation,
        ownerKey,
        reservationId,
        database,
        () => {
          releaseCapacity = true
        },
      )
    }
    if (!generationFence) {
      throw new WorkspaceStorageCompletionError(
        "Private workspace upload requires an authoritative generation",
      )
    }
    const {
      signedWorkspacePrefix: fencedPrefix,
      expectedGeneration: fencedGeneration,
    } = generationFence
    if (claim.kind === "committed") {
      return reconstructCommittedPrivateUpload(
        claim.reservation,
        fencedPrefix,
      )
    }
    if (claim.kind === "verifying") {
      return recoverVerifyingPrivateUpload(
        claim.reservation,
        fencedPrefix,
        database,
      )
    }
    return finishClaimedUpload(
      claim.reservation,
      ownerKey,
      reservationId,
      database,
      () => {
        releaseCapacity = true
      },
      {
        signedWorkspacePrefix: fencedPrefix,
        expectedGeneration: fencedGeneration,
      },
    )
  }
  try {
    let completed: CompletedWorkspaceUpload
    if (
      signedWorkspacePrefix &&
      expectedGeneration &&
      WORKSPACE_GENERATION_RE.test(expectedGeneration)
    ) {
      completed = await withWorkspaceGenerationLock(
        signedWorkspacePrefix,
        async (database) => {
          const claim = await claimUploadCompletion(
            ownerKey,
            reservationId,
            database,
            false,
            true,
          )
          return finishClaim(claim, database, {
            signedWorkspacePrefix,
            expectedGeneration,
          })
        },
      )
    } else {
      const claim = await claimUploadCompletion(
        ownerKey,
        reservationId,
        defaultDatabaseExecutor,
        true,
      )
      completed = await finishClaim(claim, defaultDatabaseExecutor)
    }
    if (leaseReservation) {
      await Promise.allSettled([
        settleLease(
          leaseReservation.byteLeaseId,
          leaseReservation.expectedBytes,
        ),
        settleLease(leaseReservation.objectLeaseId, 1),
      ])
    }
    return completed
  } catch (error) {
    if (releaseCapacity && leaseReservation) {
      await Promise.allSettled([
        dropLease(leaseReservation.byteLeaseId),
        dropLease(leaseReservation.objectLeaseId),
      ])
    }
    throw error
  }
}

export async function createPublicArtifactDownloadUrl(
  ownerEmail: string,
  key: string
): Promise<{
  downloadUrl: string
  contentLength: number
  requiredHeaders: { Range: string }
}> {
  const bucket = bucketName()
  const validatedKey = validateOwnerPublicArtifactKey(ownerEmail, key)
  const metadata = await s3Client().send(
    new HeadObjectCommand({ Bucket: bucket, Key: validatedKey }),
  )
  const contentLength = expectedLength(
    metadata.ContentLength ?? 0,
    MAX_PUBLIC_ARTIFACT_BYTES,
  )
  const range = `bytes=0-${contentLength - 1}`
  const downloadUrl = await getSignedUrl(
    s3Client(),
    new GetObjectCommand({
      Bucket: bucket,
      Key: validatedKey,
      Range: range,
    }),
    { expiresIn: 120 }
  )
  return { downloadUrl, contentLength, requiredHeaders: { Range: range } }
}

export function resetWorkspaceStorageClientForTests(): void {
  if (process.env.NODE_ENV === "test") client = null
}
