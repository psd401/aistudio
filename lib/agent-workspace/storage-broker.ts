import { createHash, randomUUID } from "node:crypto"
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

const log = createLogger({ module: "workspace-storage-broker" })

const MAX_RELATIVE_PATH_LENGTH = 768
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
const MAX_WORKSPACE_GENERATION_OBJECTS = 250_000
const WORKSPACE_CHECKPOINT_VERSION = 1 as const
const WORKSPACE_CHECKPOINT_CONTROL_PREFIX = ".workspace-checkpoints/v1"
const MAX_WORKSPACE_CHECKPOINT_BYTES = 64 * 1024 * 1024
const WORKSPACE_CHECKPOINT_CONCURRENCY = 32
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
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._@+= -]+$/
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

export function validateWorkspaceRelativePath(relativePath: string): string {
  if (
    !relativePath ||
    relativePath.length > MAX_RELATIVE_PATH_LENGTH ||
    relativePath.startsWith("/") ||
    relativePath.endsWith("/")
  ) {
    throw new Error("Invalid workspace-relative path")
  }
  const segments = relativePath.split("/")
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !SAFE_PATH_SEGMENT.test(segment)
    )
  ) {
    throw new Error("Invalid workspace-relative path")
  }
  return segments.join("/")
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
  return `${validateTrustedPrefix(signedWorkspacePrefix)}/${validateWorkspaceRelativePath(relativePath)}`
}

export type WorkspaceGenerationEntry = {
  path: string
  size: number
  eTag: string
}

function isRouterOwnedWorkspacePath(path: string): boolean {
  return path === "attachments" || path.startsWith("attachments/")
}

/**
 * Hash mutable workspace state with the same unambiguous binary framing used
 * by the agent image. Router-owned attachments are immutable, written under
 * the owner lock, and explicitly pulled by path for each turn, so excluding
 * them avoids a full workspace restore for every new upload.
 */
export function workspaceGenerationFromEntries(
  entries: readonly WorkspaceGenerationEntry[],
): string {
  const digest = createHash("sha256")
  const sorted = [...entries]
    .filter((entry) => !isRouterOwnedWorkspacePath(entry.path))
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

export function publicArtifactKey(ownerEmail: string, fileName: string): string {
  const safeName = validateWorkspaceRelativePath(fileName)
  if (safeName.includes("/")) throw new Error("Public artifact name must be a file name")
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

  const entries = (response.Contents ?? [])
    .filter((entry): entry is typeof entry & { Key: string } =>
      Boolean(entry.Key?.startsWith(prefix))
    )
    .map((entry) => ({
      path: entry.Key.slice(prefix.length),
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
    }))
    .filter((entry) => entry.path.length > 0)

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

function checkpointNamespace(signedWorkspacePrefix: string): string {
  const prefix = validateTrustedPrefix(signedWorkspacePrefix)
  const prefixHash = createHash("sha256").update(prefix).digest("hex")
  return `${WORKSPACE_CHECKPOINT_CONTROL_PREFIX}/${prefixHash}`
}

function checkpointManifestKey(signedWorkspacePrefix: string): string {
  return `${checkpointNamespace(signedWorkspacePrefix)}/manifest.json`
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
    .filter((entry) => !isRouterOwnedWorkspacePath(entry.path))
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.path, "utf8"),
        Buffer.from(right.path, "utf8"),
      ),
    )
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
  const workers = Array.from(
    {
      length: Math.min(
        WORKSPACE_CHECKPOINT_CONCURRENCY,
        values.length,
      ),
    },
    async () => {
      while (true) {
        const index = nextIndex
        nextIndex += 1
        if (index >= values.length) return
        results[index] = await operation(values[index]!, index)
      }
    },
  )
  await Promise.all(workers)
  return results
}

// Fail-closed structural validation intentionally checks every persisted field.
// eslint-disable-next-line complexity
function parseWorkspaceCheckpointManifest(
  value: unknown,
  signedWorkspacePrefix: string,
): WorkspaceCheckpointManifest {
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
    if (
      typeof entry.path !== "string" ||
      validateWorkspaceRelativePath(entry.path) !== entry.path ||
      isRouterOwnedWorkspacePath(entry.path) ||
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
    workspaceGenerationFromEntries(entries) !==
    candidate.workspaceGeneration
  ) {
    throw new WorkspaceStorageCompletionError(
      "Workspace checkpoint generation is invalid",
    )
  }
  assertPrefixFreeWorkspaceEntries(entries)
  entries.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.path, "utf8"),
      Buffer.from(right.path, "utf8"),
    ),
  )
  return {
    version: WORKSPACE_CHECKPOINT_VERSION,
    signedWorkspacePrefix: expectedPrefix,
    workspaceGeneration: candidate.workspaceGeneration,
    entries,
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
  return parseWorkspaceCheckpointManifest(parsed, signedWorkspacePrefix)
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
): Promise<WorkspaceCheckpointManifest> {
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
  return recoveredManifest
}

export async function ensureWorkspaceCheckpoint(
  signedWorkspacePrefix: string,
): Promise<{
  checkpointReady: true
  workspaceGeneration: string
}> {
  return withWorkspaceGenerationLock(
    signedWorkspacePrefix,
    async () => {
      const snapshot = await readWorkspaceGenerationSnapshot(
        signedWorkspacePrefix,
      )
      let manifest = await readWorkspaceCheckpointManifest(
        signedWorkspacePrefix,
      )
      if (!manifest) {
        manifest = await captureWorkspaceCheckpointManifest(
          signedWorkspacePrefix,
          snapshot,
        )
        await writeWorkspaceCheckpointManifest(manifest)
      } else if (
        snapshot.generation !== manifest.workspaceGeneration
      ) {
        manifest = await recoverWorkspaceCheckpoint(
          signedWorkspacePrefix,
          manifest,
          snapshot,
        )
      }
      return {
        checkpointReady: true,
        workspaceGeneration: manifest.workspaceGeneration,
      }
    },
  )
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
          manifest = await recoverWorkspaceCheckpoint(
            signedWorkspacePrefix,
            manifest,
            snapshot,
          )
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
    isRouterOwnedWorkspacePath(path) ||
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
      const nextSnapshot = await readWorkspaceGenerationSnapshot(
        signedWorkspacePrefix,
      )
      if (
        nextSnapshot.entries.has(path) ||
        nextSnapshot.generation !== expectedNextGeneration
      ) {
        throw new WorkspaceStorageSettlementUncertainError(
          "Workspace path deletion generation could not be confirmed",
        )
      }
      return {
        deleted: true,
        workspaceGeneration: nextSnapshot.generation,
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
  const relativePath = reservation.targetKey.slice(prefix.length)
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
  if (isRouterOwnedWorkspacePath(relativePath)) {
    throw new WorkspaceStorageCompletionError(
      "Router-owned attachments cannot be recovered by workspace sync",
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
      if (isRouterOwnedWorkspacePath(targetRelativePath)) {
        throw new WorkspaceStorageCompletionError(
          "Router-owned attachments cannot be promoted by workspace sync",
        )
      }
      generationSnapshot = await readWorkspaceGenerationSnapshot(
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
      await anchorCommittedCheckpointPathBeforePromotion(
        generationFence.signedWorkspacePrefix,
        targetRelativePath,
      )
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
