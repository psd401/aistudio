import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import {
  createPublicArtifactUpload,
  createPublicArtifactDownloadUrl,
  completeWorkspaceUpload,
  createWorkspaceDownloadUrl,
  createWorkspaceUploadUrl,
  listWorkspaceObjects,
  WorkspaceStorageAdmissionError,
  WorkspaceStorageCompletionError,
} from "@/lib/agent-workspace/storage-broker"
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
])

type StorageRequest = {
  operation:
    | "list"
    | "download"
    | "upload"
    | "publish"
    | "download-public"
    | "complete-upload"
  path?: string
  continuationToken?: string
  contentType?: string
  contentLength?: number
  idempotencyKey?: string
  checksumSha256?: string
  reservationId?: string
}

function parseRequest(value: unknown): StorageRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field))) return null
  if (
    body.operation !== "list" &&
    body.operation !== "download" &&
    body.operation !== "upload" &&
    body.operation !== "publish" &&
    body.operation !== "download-public" &&
    body.operation !== "complete-upload"
  ) {
    return null
  }
  if (
    body.path !== undefined && typeof body.path !== "string" ||
    body.continuationToken !== undefined &&
      typeof body.continuationToken !== "string" ||
    body.contentType !== undefined && typeof body.contentType !== "string"
    || body.contentLength !== undefined &&
      (!Number.isSafeInteger(body.contentLength) || (body.contentLength as number) < 1)
    || body.idempotencyKey !== undefined &&
      (typeof body.idempotencyKey !== "string" ||
        body.idempotencyKey.length < 8 ||
        body.idempotencyKey.length > 128)
    || body.checksumSha256 !== undefined &&
      (typeof body.checksumSha256 !== "string" ||
        !/^[A-Za-z0-9+/]{43}=$/.test(body.checksumSha256))
    || body.reservationId !== undefined &&
      (typeof body.reservationId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(body.reservationId))
  ) {
    return null
  }
  return body as StorageRequest
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
    let result: object
    if (input.operation === "list") {
      result = await listWorkspaceObjects(
        context.workspacePrefix,
        input.continuationToken
      )
    } else if (input.operation === "download" && input.path) {
      result = await createWorkspaceDownloadUrl(
        context.workspacePrefix,
        input.path
      )
    } else if (
      input.operation === "upload" &&
      input.path &&
      input.contentLength &&
      input.idempotencyKey &&
      input.checksumSha256
    ) {
      result = await createWorkspaceUploadUrl(
          context.ownerEmail,
          context.workspacePrefix,
          input.path,
          input.contentLength,
          `${context.sessionId}:${context.nonce}`,
          input.idempotencyKey,
          input.checksumSha256,
          input.contentType
        )
    } else if (
      input.operation === "publish" &&
      input.path &&
      input.contentType &&
      input.contentLength &&
      input.idempotencyKey &&
      input.checksumSha256
    ) {
      result = await createPublicArtifactUpload(
        context.ownerEmail,
        input.path,
        input.contentType,
        input.contentLength,
        `${context.sessionId}:${context.nonce}`,
        input.idempotencyKey,
        input.checksumSha256,
      )
    } else if (input.operation === "download-public" && input.path) {
      result = await createPublicArtifactDownloadUrl(
        context.ownerEmail,
        input.path
      )
    } else if (
      input.operation === "complete-upload" &&
      input.reservationId
    ) {
      result = await completeWorkspaceUpload(
        context.ownerEmail,
        input.reservationId,
      )
    } else {
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
        path: input.path,
      })
    )
    return NextResponse.json(result)
  } catch (error) {
    log.warn(
      "Owner-bound workspace storage operation rejected",
      sanitizeForLogging({
        requestId,
        ownerEmail: context.ownerEmail,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message.startsWith("Invalid")
            ? error.message
            : "Workspace storage operation failed",
      },
      {
        status:
          error instanceof WorkspaceStorageAdmissionError
            ? 429
            : error instanceof WorkspaceStorageCompletionError
              ? 409
            : error instanceof Error && error.message.startsWith("Invalid")
              ? 400
              : 502,
        ...(error instanceof WorkspaceStorageAdmissionError
          ? { headers: { "Retry-After": "60" } }
          : {}),
      }
    )
  }
}
