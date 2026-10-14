import { Buffer } from "node:buffer"
import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import {
  createPublicArtifactUpload,
  createPublicArtifactDownloadUrl,
  createDriveDeliveryUpload,
  completeWorkspaceUpload,
  commitWorkspaceCheckpoint,
  deliverStagedUploadToDrive,
  deleteWorkspacePath,
  createWorkspaceDownloadUrl,
  createWorkspaceUploadUrl,
  ensureWorkspaceCheckpoint,
  finalizeWorkspaceCheckpoint,
  listWorkspaceObjects,
  releaseWorkspaceUploads,
  WorkspacePublicArtifactRefusedError,
  WorkspaceStorageAdmissionError,
  WorkspaceStorageCompletionError,
} from "@/lib/agent-workspace/storage-broker"
import { executeQuery } from "@/lib/db/drizzle-client"
import { agentFailures } from "@/lib/db/schema"
import {
  DriveDeliveryError,
  driveDeliveryExtension,
  isDriveDeliverableName,
} from "@/lib/agent-workspace/drive-delivery"
import { workspaceRelativePathRejectionReason } from "@/lib/agent-workspace/path-policy"
import { describeQueryErrorCause } from "@/lib/db/query-error"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"

const log = createLogger({ module: "agent-workspace-storage" })
const ALLOWED_FIELDS = new Set([
  "operation",
  "path",
  "continuationToken",
  "contentType",
  "contentLength",
  "idempotencyKey",
  "checksumSha256",
  "reservationId",
  "reservationIds",
  "baseWorkspaceGeneration",
  "workspaceGeneration",
  "deletedPaths",
  "checkpointFinalizationProof",
])
const STORAGE_OPERATIONS = new Set([
  "list",
  "download",
  "upload",
  "publish",
  "download-public",
  // Private delivery into the agent account's Drive (#1885): `drive-upload`
  // stages the bytes, `deliver-to-drive` creates the file as the agent account
  // and shares it with the caller alone. Two steps rather than one for the same
  // reason `publish` is: the bytes go to S3 over a signed PUT, never through
  // this JSON route.
  "drive-upload",
  "deliver-to-drive",
  "complete-upload",
  "release-upload",
  "ensure-checkpoint",
  "commit-checkpoint",
  "finalize-checkpoint",
  "delete",
])
// An abort carries only the ids it is abandoning. Keeping the field set as
// tight as finalize-checkpoint's means a release can never smuggle a path, a
// generation, or a proof past the parser.
const RELEASE_UPLOAD_FIELDS = new Set(["operation", "reservationIds"])
const MAX_RELEASE_UPLOAD_ITEMS = 250
const FINALIZE_CHECKPOINT_FIELDS = new Set([
  "operation",
  "baseWorkspaceGeneration",
  "reservationIds",
  "deletedPaths",
  "checkpointFinalizationProof",
])
const MAX_FINALIZE_CHECKPOINT_ITEMS = 250_000
const MAX_CHECKPOINT_FINALIZATION_PROOF_LENGTH = 4_096
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const WORKSPACE_GENERATION_RE = /^[0-9a-f]{64}$/

type StorageRequest = {
  operation:
    | "list"
    | "download"
    | "upload"
    | "publish"
    | "download-public"
    | "drive-upload"
    | "deliver-to-drive"
    | "complete-upload"
    | "release-upload"
    | "ensure-checkpoint"
    | "commit-checkpoint"
    | "finalize-checkpoint"
    | "delete"
  path?: string
  continuationToken?: string
  contentType?: string
  contentLength?: number
  idempotencyKey?: string
  checksumSha256?: string
  reservationId?: string
  reservationIds?: string[]
  baseWorkspaceGeneration?: string
  workspaceGeneration?: string
  deletedPaths?: string[]
  checkpointFinalizationProof?: string
}

type AgentInvocation = NonNullable<
  Awaited<ReturnType<typeof verifyAgentInvocationContext>>
>

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function hasValidStorageFields(body: Record<string, unknown>): boolean {
  const contentLengthValid =
    body.contentLength === undefined ||
    (Number.isSafeInteger(body.contentLength) &&
      (body.contentLength as number) >= 0)
  const idempotencyKeyValid =
    body.idempotencyKey === undefined ||
    (typeof body.idempotencyKey === "string" &&
      body.idempotencyKey.length >= 8 &&
      body.idempotencyKey.length <= 128)
  const checksumValid =
    body.checksumSha256 === undefined ||
    (typeof body.checksumSha256 === "string" &&
      /^[A-Za-z0-9+/]{43}=$/.test(body.checksumSha256))
  const reservationValid =
    body.reservationId === undefined ||
    (typeof body.reservationId === "string" &&
      /^[0-9a-f-]{36}$/i.test(body.reservationId))
  const workspaceGenerationValid =
    body.workspaceGeneration === undefined ||
    (typeof body.workspaceGeneration === "string" &&
      WORKSPACE_GENERATION_RE.test(body.workspaceGeneration))
  const baseWorkspaceGenerationValid =
    body.baseWorkspaceGeneration === undefined ||
    (typeof body.baseWorkspaceGeneration === "string" &&
      WORKSPACE_GENERATION_RE.test(body.baseWorkspaceGeneration))
  return [
    isOptionalString(body.path),
    isOptionalString(body.continuationToken),
    isOptionalString(body.contentType),
    contentLengthValid,
    idempotencyKeyValid,
    checksumValid,
    reservationValid,
    baseWorkspaceGenerationValid,
    workspaceGenerationValid,
  ].every(Boolean)
}

function isOrderedUniqueStringArray(
  value: unknown,
  isValid: (item: string) => boolean,
  normalize: (item: string) => string = (item) => item,
): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_FINALIZE_CHECKPOINT_ITEMS) {
    return false
  }
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== "string" || !isValid(item)) return false
    const identity = normalize(item)
    if (seen.has(identity)) return false
    seen.add(identity)
  }
  return true
}

function hasValidFinalizeCheckpointFields(
  body: Record<string, unknown>,
): boolean {
  if (
    Object.keys(body).some(
      (field) => !FINALIZE_CHECKPOINT_FIELDS.has(field),
    ) ||
    typeof body.baseWorkspaceGeneration !== "string" ||
    !WORKSPACE_GENERATION_RE.test(body.baseWorkspaceGeneration) ||
    typeof body.checkpointFinalizationProof !== "string" ||
    body.checkpointFinalizationProof.length === 0 ||
    Buffer.byteLength(body.checkpointFinalizationProof, "utf8") >
      MAX_CHECKPOINT_FINALIZATION_PROOF_LENGTH ||
    !isOrderedUniqueStringArray(
      body.reservationIds,
      (item) => UUID_RE.test(item),
      (item) => item.toLowerCase(),
    ) ||
    !isOrderedUniqueStringArray(
      body.deletedPaths,
      (item) =>
        item.trim().length > 0 &&
        workspaceRelativePathRejectionReason(item) === null,
    )
  ) {
    return false
  }
  return (
    body.reservationIds.length + body.deletedPaths.length <=
    MAX_FINALIZE_CHECKPOINT_ITEMS
  )
}

function hasValidReleaseUploadFields(
  body: Record<string, unknown>,
): boolean {
  return (
    !Object.keys(body).some((field) => !RELEASE_UPLOAD_FIELDS.has(field)) &&
    isOrderedUniqueStringArray(
      body.reservationIds,
      (item) => UUID_RE.test(item),
      (item) => item.toLowerCase(),
    ) &&
    body.reservationIds.length > 0 &&
    body.reservationIds.length <= MAX_RELEASE_UPLOAD_ITEMS
  )
}

function parseRequest(value: unknown): StorageRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field))) return null
  if (
    typeof body.operation !== "string" ||
    !STORAGE_OPERATIONS.has(body.operation) ||
    !hasValidStorageFields(body)
  ) return null
  if (body.operation === "finalize-checkpoint") {
    if (!hasValidFinalizeCheckpointFields(body)) return null
  } else if (body.operation === "release-upload") {
    if (!hasValidReleaseUploadFields(body)) return null
  } else if (
    body.reservationIds !== undefined ||
    body.deletedPaths !== undefined ||
    body.checkpointFinalizationProof !== undefined
  ) {
    return null
  }
  return body as StorageRequest
}

// Explicit operation dispatch is easier to audit than dynamic broker lookup.
// eslint-disable-next-line complexity
async function executeStorageOperation(
  input: StorageRequest,
  context: AgentInvocation
): Promise<object | null> {
  const contextKey = `${context.sessionId}:${context.nonce}`
  switch (input.operation) {
    case "list":
      return listWorkspaceObjects(
        context.workspacePrefix,
        input.continuationToken
      )
    case "download":
      return input.path
        ? createWorkspaceDownloadUrl(context.workspacePrefix, input.path)
        : null
    case "upload":
      return executePrivateUpload(input, context, contextKey)
    case "publish":
      return executePublicUpload(input, context, contextKey)
    case "download-public":
      return input.path
        ? createPublicArtifactDownloadUrl(context.ownerEmail, input.path)
        : null
    case "drive-upload":
      return executeDriveDeliveryUpload(input, context, contextKey)
    case "deliver-to-drive":
      return input.reservationId
        ? deliverStagedUploadToDrive(context.ownerEmail, input.reservationId)
        : null
    case "complete-upload":
      return input.reservationId
        ? completeWorkspaceUpload(
            context.ownerEmail,
            input.reservationId,
            context.workspacePrefix,
            input.workspaceGeneration,
          )
        : null
    case "release-upload":
      return input.reservationIds
        ? releaseWorkspaceUploads(context.ownerEmail, input.reservationIds)
        : null
    case "ensure-checkpoint":
      return ensureWorkspaceCheckpoint(context.workspacePrefix, {
        invocationNonce: context.nonce,
        expiresAt: context.expiresAt,
      })
    case "commit-checkpoint":
      return input.baseWorkspaceGeneration && input.workspaceGeneration
        ? commitWorkspaceCheckpoint(
            context.workspacePrefix,
            input.baseWorkspaceGeneration,
            input.workspaceGeneration,
          )
        : null
    case "finalize-checkpoint":
      return input.baseWorkspaceGeneration &&
        input.reservationIds &&
        input.deletedPaths &&
        input.checkpointFinalizationProof
        ? finalizeWorkspaceCheckpoint(
            context.ownerEmail,
            context.workspacePrefix,
            input.baseWorkspaceGeneration,
            input.reservationIds,
            input.deletedPaths,
            input.checkpointFinalizationProof,
            context.nonce,
            context.expiresAt,
          )
        : null
    case "delete":
      return input.path && input.workspaceGeneration
        ? deleteWorkspacePath(
            context.workspacePrefix,
            input.path,
            input.workspaceGeneration,
          )
        : null
  }
}

function executePrivateUpload(
  input: StorageRequest,
  context: AgentInvocation,
  contextKey: string
): Promise<object> | null {
  if (
    !input.path ||
    input.contentLength === undefined ||
    !input.idempotencyKey ||
    !input.checksumSha256 ||
    !input.workspaceGeneration
  ) return null
  return createWorkspaceUploadUrl({
    ownerEmail: context.ownerEmail,
    signedWorkspacePrefix: context.workspacePrefix,
    relativePath: input.path,
    contentLength: input.contentLength,
    contextKey,
    idempotencyKey: input.idempotencyKey,
    checksumSha256: input.checksumSha256,
    contentType: input.contentType,
  })
}

function executePublicUpload(
  input: StorageRequest,
  context: AgentInvocation,
  contextKey: string
): Promise<object> | null {
  if (
    !input.path ||
    !input.contentType ||
    !input.contentLength ||
    !input.idempotencyKey ||
    !input.checksumSha256
  ) return null
  return createPublicArtifactUpload({
    ownerEmail: context.ownerEmail,
    fileName: input.path,
    contentType: input.contentType,
    contentLength: input.contentLength,
    contextKey,
    idempotencyKey: input.idempotencyKey,
    checksumSha256: input.checksumSha256,
  })
}

function executeDriveDeliveryUpload(
  input: StorageRequest,
  context: AgentInvocation,
  contextKey: string
): Promise<object> | null {
  if (
    !input.path ||
    !input.contentType ||
    input.contentLength === undefined ||
    !input.idempotencyKey ||
    !input.checksumSha256
  ) return null
  return createDriveDeliveryUpload({
    ownerEmail: context.ownerEmail,
    fileName: input.path,
    contentType: input.contentType,
    contentLength: input.contentLength,
    contextKey,
    idempotencyKey: input.idempotencyKey,
    checksumSha256: input.checksumSha256,
  })
}

/**
 * What the agent is told to do instead of retrying. Pasted into the response
 * so the model does not have to remember the two private routes: #1885's Drive
 * delivery, or an Atrium page that carries an owner and a visibility level.
 */
const PERSONAL_DATA_GUIDANCE =
  "Do NOT retry this as a public link — it will be refused again. Deliver the " +
  "file privately instead: `node /opt/psd-skills/psd-publish-file/publish.js " +
  "--file <path>` (the default --to drive creates it in your Drive and shares " +
  "it with the caller alone), or publish it as a private Atrium page. If the " +
  "file is genuinely meant to be public, remove the personal data from it " +
  "first and publish the redacted version."

/**
 * Count a refusal in `agent_failures` so the gate's false-positive rate is
 * measurable (#1886 risk note: "log every refusal").
 *
 * Source `router` rather than `harness`: the refusal is the web broker's
 * decision, not something the container reported about itself. Best-effort —
 * the refusal response must be returned whether or not the row lands, so a
 * failed insert is logged and swallowed.
 */
async function recordPublicArtifactRefusal(
  error: WorkspacePublicArtifactRefusedError,
  context: AgentInvocation,
  requestId: string
): Promise<void> {
  try {
    await executeQuery(
      (db) =>
        db.insert(agentFailures).values({
          source: "router",
          severity: "warn",
          userId: context.ownerEmail,
          sessionId: context.sessionId,
          errorClass: "PublicArtifactPersonalDataRefused",
          // The kinds, never the matched values.
          errorMessage: `Public link refused: ${error.kinds.join(", ")}`,
          context: { requestId, kinds: [...error.kinds] },
        }),
      "recordPublicArtifactPersonalDataRefusal"
    )
  } catch (insertError) {
    log.error(
      "Public link refusal could not be recorded",
      sanitizeForLogging({
        requestId,
        error:
          insertError instanceof Error
            ? insertError.message
            : String(insertError),
      })
    )
  }
}

/**
 * Turn a broker rejection into the response the AGENT can act on.
 *
 * Two classes of error are reported verbatim rather than collapsed into the
 * generic message:
 *
 *  - anything starting with "Invalid" — a request the caller can correct;
 *  - a `DriveDeliveryError` — `unsupported_type` names what IS deliverable and
 *    `share_failed` says to retry. Its `code` is echoed so the skill branches on
 *    a code rather than on English, and `share_failed` in particular must never
 *    read as "fall back to a public link".
 *
 * Everything else stays opaque: a storage failure's internals are not the
 * model's business.
 */
function storageFailureResponse(error: unknown): NextResponse {
  const isInvalidRequest =
    error instanceof Error && error.message.startsWith("Invalid")
  const isDriveRefusal = error instanceof DriveDeliveryError
  // A personal-data refusal is reported in full, with the guidance attached:
  // this is the one rejection whose whole value is that the agent changes
  // course instead of retrying. `kinds` names the patterns, never the values.
  if (error instanceof WorkspacePublicArtifactRefusedError) {
    return NextResponse.json(
      {
        error: `${error.message} ${PERSONAL_DATA_GUIDANCE}`,
        code: error.code,
        kinds: [...error.kinds],
      },
      { status: 422 }
    )
  }
  return NextResponse.json(
    {
      error:
        isDriveRefusal || isInvalidRequest
          ? (error as Error).message
          : "Workspace storage operation failed",
      ...(isDriveRefusal ? { code: error.code } : {}),
    },
    {
      status: storageFailureStatus(error, isInvalidRequest),
      ...(error instanceof WorkspaceStorageAdmissionError
        ? { headers: { "Retry-After": "60" } }
        : {}),
    }
  )
}

function storageFailureStatus(
  error: unknown,
  isInvalidRequest: boolean
): number {
  if (error instanceof WorkspaceStorageAdmissionError) return 429
  if (error instanceof DriveDeliveryError) {
    // A share that failed is retryable (409, same as a lost completion race).
    // A create failure is Drive being unreachable, slow, or 5xx on a valid
    // request — an upstream failure (502), not the caller's to fix. Only a type
    // or MIME refusal is the caller's own request to fix (400).
    if (error.code === "share_failed") return 409
    if (error.code === "create_failed") return 502
    return 400
  }
  if (error instanceof WorkspaceStorageCompletionError) return 409
  return isInvalidRequest ? 400 : 502
}

/**
 * The path to log for an operation. A `drive-upload` path is the name of a file
 * whose whole purpose is carrying personal data (often named after a student),
 * so at most a KNOWN deliverable extension is logged. Anything after the last
 * dot is not safe on its own: "Maria.Garcia" would log a surname.
 */
function loggablePath(input: StorageRequest): string | undefined {
  if (input.operation !== "drive-upload" || !input.path) return input.path
  return isDriveDeliverableName(input.path)
    ? `*${driveDeliveryExtension(input.path)}`
    : "*"
}

/**
 * The error to log. A Drive type refusal on `drive-upload` quotes the name's
 * "extension" back to the agent — useful in the response, a leak in the log —
 * so only its code is logged.
 */
function loggableError(input: StorageRequest, error: unknown): string {
  if (input.operation === "drive-upload" && error instanceof DriveDeliveryError) {
    return error.code
  }
  return error instanceof Error ? error.message : String(error)
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const context = await verifyAgentInvocationContext(request, {
    allowedModes: ["owner", "scheduled"],
  })
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const input = parseRequest(body)
  if (!input) {
    return NextResponse.json({ error: "Invalid storage request" }, { status: 400 })
  }

  try {
    const result = await executeStorageOperation(input, context)
    if (!result) {
      return NextResponse.json(
        { error: "Storage operation is missing required fields" },
        { status: 400 }
      )
    }
    log.info(
      "Owner-bound workspace storage operation completed",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        operation: input.operation,
        path: loggablePath(input),
      })
    )
    return NextResponse.json(result)
  } catch (error) {
    log.warn(
      "Owner-bound workspace storage operation rejected",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        operation: input.operation,
        path: loggablePath(input),
        error: loggableError(input, error),
        // See lib/db/query-error.ts — Drizzle swallows the driver's real cause.
        ...describeQueryErrorCause(error),
      })
    )
    if (error instanceof WorkspacePublicArtifactRefusedError) {
      await recordPublicArtifactRefusal(error, context, requestId)
    }
    return storageFailureResponse(error)
  }
}
