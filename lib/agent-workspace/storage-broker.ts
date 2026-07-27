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
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client"
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

function expectedLength(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
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
    units: params.contentLength,
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
  entries: Array<{ path: string; size: number; lastModified: number }>
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
): Promise<UploadPreparation | {
  unchanged: true
  key: string
}> {
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
  const length = expectedLength(contentLength, MAX_PRIVATE_UPLOAD_BYTES)
  const checksum = expectedChecksum(checksumSha256)
  const normalizedContentType = expectedContentType(contentType)
  const targetKey = ownerWorkspaceKey(signedWorkspacePrefix, relativePath)
  const existing = await existingUploadReservation(ownerEmail, idempotencyKey)
  if (existing) {
    if (
      existing.publicArtifact ||
      existing.targetKey !== targetKey ||
      existing.expectedBytes !== length ||
      existing.checksumSha256 !== checksum ||
      existing.contentType !== normalizedContentType
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
      const metadata = await s3Client().send(
        new HeadObjectCommand({
          Bucket: bucketName(),
          Key: targetKey,
          ChecksumMode: "ENABLED",
        }),
      )
      if (
        metadata.ContentLength !== length ||
        metadata.ChecksumSHA256 !== checksum ||
        metadata.ContentType !== normalizedContentType ||
        metadata.VersionId !== existing.objectVersionId
      ) {
        throw new WorkspaceStorageCompletionError(
          "Committed upload no longer matches its reservation",
        )
      }
      return { unchanged: true, key: targetKey }
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
      contentLength: length,
      checksumSha256: checksum,
      contentType: normalizedContentType,
    })
  }
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
              ownerEmail.trim().toLowerCase(),
            ),
            eq(workspaceUploadReservations.targetKey, targetKey),
            eq(workspaceUploadReservations.expectedBytes, length),
            eq(workspaceUploadReservations.checksumSha256, checksum),
            eq(
              workspaceUploadReservations.contentType,
              normalizedContentType,
            ),
            eq(workspaceUploadReservations.status, "committed"),
          ),
        )
        .limit(1),
    "findUnchangedWorkspaceUpload",
  )
  if (unchanged?.objectVersionId) {
    try {
      const metadata = await s3Client().send(
        new HeadObjectCommand({
          Bucket: bucketName(),
          Key: unchanged.targetKey,
          ChecksumMode: "ENABLED",
        }),
      )
      if (
        metadata.ContentLength === length &&
        metadata.ChecksumSHA256 === checksum &&
        metadata.ContentType === normalizedContentType &&
        metadata.VersionId === unchanged.objectVersionId
      ) {
        return { unchanged: true, key: targetKey }
      }
    } catch {
      // A stale ledger row is not proof the bytes still exist. Continue with a
      // new verified upload; the retained row remains charged until cleanup.
    }
  }
  const leaseIds = await reserveUpload({
    publicArtifact: false,
    ownerEmail,
    contextKey,
    idempotencyKey,
    contentLength: length,
  })
  const reservation = await createUploadReservation({
    publicArtifact: false,
    ownerEmail,
    contextKey,
    idempotencyKey,
    targetKey,
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
      "rejectWorkspaceUploadSigning",
    )
    await Promise.all(
      leaseIds.filter((id): id is string => id !== null).map(releaseResourceAdmission),
    )
    throw error
  }
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

export async function completeWorkspaceUpload(
  ownerEmail: string,
  reservationId: string,
): Promise<{ key: string; publicUrl?: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(reservationId)) {
    throw new Error("Invalid upload reservation")
  }
  const ownerKey = ownerEmail.trim().toLowerCase()
  const [claimed] = await executeQuery(
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
          ),
        )
        .returning(),
    "claimWorkspaceUploadCompletion",
  )
  if (!claimed) {
    const [existing] = await executeQuery(
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
    if (existing?.status === "committed") {
      await Promise.allSettled([
        settleLease(existing.byteLeaseId, existing.expectedBytes),
        settleLease(existing.objectLeaseId, 1),
      ])
      return {
        key: existing.targetKey,
        ...(existing.publicArtifact
          ? { publicUrl: publicUrl(bucketName(), existing.targetKey) }
          : {}),
      }
    }
    throw new WorkspaceStorageCompletionError(
      "Upload reservation is unavailable or already being verified",
    )
  }

  const bucket = bucketName()
  let stagingVersion: string | undefined
  let promotedVersion: string | undefined
  let settled = false
  try {
    const metadata = await s3Client().send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: claimed.stagingKey,
        ChecksumMode: "ENABLED",
      }),
    )
    stagingVersion = metadata.VersionId
    if (
      metadata.ContentLength !== claimed.expectedBytes ||
      metadata.ChecksumSHA256 !== claimed.checksumSha256 ||
      metadata.ContentType !== claimed.contentType ||
      !stagingVersion
    ) {
      throw new WorkspaceStorageCompletionError(
        "Uploaded object did not match its reservation",
      )
    }
    const priorVersions = await executeQuery(
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
              eq(workspaceUploadReservations.targetKey, claimed.targetKey),
              eq(workspaceUploadReservations.status, "committed"),
            ),
          ),
      "getSupersededWorkspaceUploadVersions",
    )
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
    promotedVersion = copied.VersionId
    await s3Client().send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: claimed.stagingKey,
        VersionId: stagingVersion,
      }),
    )
    const settledRow = await executeTransaction(
      async (tx) => {
        const [row] = await tx
          .update(workspaceUploadReservations)
          .set({
            status: "committed",
            objectVersionId: copied.VersionId,
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
        return row
      },
      "settleWorkspaceUploadCompletion",
    )
    if (!settledRow) {
      throw new WorkspaceStorageCompletionError(
        "Upload reservation settlement was lost",
      )
    }
    settled = true
    await Promise.allSettled([
      settleLease(claimed.byteLeaseId, claimed.expectedBytes),
      settleLease(claimed.objectLeaseId, 1),
    ])
    for (const prior of priorVersions) {
      if (!prior.objectVersionId) continue
      try {
        await s3Client().send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: claimed.targetKey,
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
    return {
      key: claimed.targetKey,
      ...(claimed.publicArtifact
        ? { publicUrl: publicUrl(bucket, claimed.targetKey) }
        : {}),
    }
  } catch (error) {
    if (settled) throw error
    let cleanupFailed = false
    if (promotedVersion) {
      try {
        await s3Client().send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: claimed.targetKey,
            VersionId: promotedVersion,
          }),
        )
      } catch {
        cleanupFailed = true
      }
    }
    if (stagingVersion) {
      try {
        await s3Client().send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: claimed.stagingKey,
            VersionId: stagingVersion,
          }),
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
    await executeQuery(
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
    await Promise.all([
      dropLease(claimed.byteLeaseId),
      dropLease(claimed.objectLeaseId),
    ])
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
