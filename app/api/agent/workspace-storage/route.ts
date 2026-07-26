import { NextRequest, NextResponse } from "next/server"
import { verifyAgentInvocationContext } from "@/lib/agent-workspace/invocation-context"
import {
  createPublicArtifactUpload,
  createPublicArtifactDownloadUrl,
  createWorkspaceDownloadUrl,
  createWorkspaceUploadUrl,
  listWorkspaceObjects,
} from "@/lib/agent-workspace/storage-broker"
import { createLogger, generateRequestId, sanitizeForLogging } from "@/lib/logger"

const log = createLogger({ module: "agent-workspace-storage" })
const ALLOWED_FIELDS = new Set([
  "operation",
  "path",
  "continuationToken",
  "contentType",
])

type StorageRequest = {
  operation: "list" | "download" | "upload" | "publish" | "download-public"
  path?: string
  continuationToken?: string
  contentType?: string
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
    body.operation !== "download-public"
  ) {
    return null
  }
  if (
    body.path !== undefined && typeof body.path !== "string" ||
    body.continuationToken !== undefined &&
      typeof body.continuationToken !== "string" ||
    body.contentType !== undefined && typeof body.contentType !== "string"
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
      result = {
        downloadUrl: await createWorkspaceDownloadUrl(
          context.workspacePrefix,
          input.path
        ),
      }
    } else if (input.operation === "upload" && input.path) {
      result = {
        uploadUrl: await createWorkspaceUploadUrl(
          context.workspacePrefix,
          input.path,
          input.contentType
        ),
      }
    } else if (
      input.operation === "publish" &&
      input.path &&
      input.contentType
    ) {
      result = await createPublicArtifactUpload(
        context.ownerEmail,
        input.path,
        input.contentType
      )
    } else if (input.operation === "download-public" && input.path) {
      result = {
        downloadUrl: await createPublicArtifactDownloadUrl(
          context.ownerEmail,
          input.path
        ),
      }
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
          error instanceof Error && error.message.startsWith("Invalid") ? 400 : 502,
      }
    )
  }
}
