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
const STORAGE_OPERATIONS = new Set([
  "list",
  "download",
  "upload",
  "publish",
  "download-public",
  "complete-upload",
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
      (body.contentLength as number) >= 1)
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
  return [
    isOptionalString(body.path),
    isOptionalString(body.continuationToken),
    isOptionalString(body.contentType),
    contentLengthValid,
    idempotencyKeyValid,
    checksumValid,
    reservationValid,
  ].every(Boolean)
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
  return body as StorageRequest
}

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
    case "complete-upload":
      return input.reservationId
        ? completeWorkspaceUpload(context.ownerEmail, input.reservationId)
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
    !input.contentLength ||
    !input.idempotencyKey ||
    !input.checksumSha256
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
