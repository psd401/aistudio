import { z } from "zod"
import {
  ApprovalRequiredError,
  ForbiddenError,
  contentService,
  isContentError,
  publishService,
  recordContentAudit,
  visibilityService,
  type ContentAuditAction,
  type Requester,
} from "@/lib/content"
import { decodeContentBody } from "@/lib/content/code-encoding"
import type { PublishDestination } from "@/lib/content/publish-adapters/types"
import { requesterForUserId } from "@/lib/content/requester-from-auth"
import {
  assertContentAuthoringCapability,
  contentDeepLink,
  resolveCollectionId,
} from "@/lib/content/surface-helpers"
import { contentSourceRefSchema } from "@/lib/content/source-ref"
import { getUserByEmail } from "@/lib/db/drizzle/users"

const visibilitySchema = z
  .object({
    level: z.enum(["private", "group", "internal", "public"]),
    grants: z
      .array(
        z
          .object({
            kind: z.enum([
              "role",
              "building",
              "department",
              "grade",
              "user",
              "group",
            ]),
            value: z.string().min(1).max(500),
          })
          .strict()
      )
      .optional(),
  })
  .strict()

const listQuerySchema = z
  .object({
    kind: z.enum(["document", "artifact"]).optional(),
    collection: z.string().min(1).max(200).optional(),
    tag: z.string().min(1).max(100).optional(),
    status: z.enum(["draft", "published", "archived"]).optional(),
    query: z.string().min(1).max(200).optional(),
  })
  .strict()

const createSchema = z
  .object({
    kind: z.enum(["document", "artifact"]),
    title: z.string().min(1).max(500),
    collectionId: z.string().min(1).max(200).optional(),
    body: z.string().optional(),
    bodyFormat: z.enum(["markdown", "html", "jsx"]).optional(),
    codeEncoding: z.literal("base64").optional(),
    visibility: visibilitySchema.optional(),
    tags: z.array(z.string().max(500)).optional(),
    sourceRef: contentSourceRefSchema.optional(),
  })
  .strict()

const updateSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    tags: z.array(z.string().max(500)).nullable().optional(),
    collectionId: z.string().min(1).max(200).nullable().optional(),
    status: z.enum(["draft", "published", "archived"]).optional(),
  })
  .strict()

const versionSchema = z
  .object({
    body: z.string().min(1),
    bodyFormat: z.enum(["markdown", "html", "jsx"]).optional(),
    codeEncoding: z.literal("base64").optional(),
    summary: z.string().max(2000).optional(),
  })
  .strict()

const publishSchema = z
  .object({
    destination: z.enum([
      "intranet",
      "public_web",
      "schoology",
      "google",
      "okf",
    ]),
    visibility: visibilitySchema.optional(),
  })
  .strict()

type AgentAtriumOperationInput = {
  ownerEmail: string
  requestId: string
  method: "GET" | "POST" | "PATCH" | "DELETE"
  path: string
  query?: Record<string, string>
  body?: Record<string, unknown>
}

export type AgentAtriumOperationResult = {
  httpStatus: number
  payload: unknown
}

type MutationAudit = {
  action: ContentAuditAction
  objectId?: string
  destination?: PublishDestination
}

function success(
  data: unknown,
  requestId: string,
  httpStatus = 200
): AgentAtriumOperationResult {
  return { httpStatus, payload: { data, meta: { requestId } } }
}

function contentFailure(
  error: unknown,
  requestId: string
): AgentAtriumOperationResult {
  if (!isContentError(error)) throw error
  return {
    httpStatus: error.status,
    payload: {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      requestId,
    },
  }
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 31 || code === 127
  })
}

function parsePath(path: string): string[] {
  if (path === "") return []
  const rawSegments = path.slice(1).split("/")
  return rawSegments.map((segment) => {
    const value = decodeURIComponent(segment)
    if (
      value.length === 0 ||
      value.length > 384 ||
      value.includes("/") ||
      value.includes("\\") ||
      hasAsciiControl(value)
    ) {
      throw new ForbiddenError("Invalid Atrium content identifier")
    }
    return value
  })
}

async function ownerRequester(ownerEmail: string): Promise<{
  req: Requester
  cognitoSub: string
}> {
  const owner = await getUserByEmail(ownerEmail)
  const req = await requesterForUserId(owner.id)
  if (!req || !owner.cognitoSub) {
    throw new ForbiddenError("Signed Atrium owner is not an active user")
  }
  return { req, cognitoSub: owner.cognitoSub }
}

function recordAudit(
  req: Requester,
  audit: MutationAudit,
  requestId: string,
  outcome: "ok" | "error" | "approval_required",
  error?: unknown
): void {
  void recordContentAudit({
    req,
    action: audit.action,
    surface: "rest",
    objectId: audit.objectId,
    destination: audit.destination,
    outcome,
    ...(error
      ? { error: error instanceof Error ? error.message : String(error) }
      : {}),
    requestId,
  })
}

/**
 * Execute the fixed Atrium agent surface as the human named by the signed
 * invocation proof. No reusable service credential crosses into the workspace.
 */
export async function executeOwnerAtriumOperation(
  input: AgentAtriumOperationInput
): Promise<AgentAtriumOperationResult> {
  const segments = parsePath(input.path)
  const { req, cognitoSub } = await ownerRequester(input.ownerEmail)
  let audit: MutationAudit | undefined

  try {
    if (input.method === "GET" && segments.length === 0) {
      const query = listQuerySchema.parse(input.query ?? {})
      const collectionId = await resolveCollectionId(query.collection)
      const items = await contentService.list(req, {
        kind: query.kind,
        collectionId,
        tag: query.tag,
        status: query.status,
        query: query.query,
      })
      return success(items, input.requestId)
    }

    if (input.method === "GET" && segments.length === 1) {
      const object = await contentService.get(req, segments[0])
      return success(
        { ...object, url: contentDeepLink(object.slug) },
        input.requestId
      )
    }

    await assertContentAuthoringCapability({
      authType: "session",
      cognitoSub,
    })

    if (input.method === "POST" && segments.length === 0) {
      audit = { action: "create" }
      const body = createSchema.parse(input.body ?? {})
      const created = await contentService.create(
        req,
        {
          kind: body.kind,
          title: body.title,
          collectionId: await resolveCollectionId(body.collectionId),
          body: decodeContentBody(body.body, body.codeEncoding),
          bodyFormat: body.bodyFormat,
          visibility: body.visibility,
          tags: body.tags,
          sourceRef: body.sourceRef,
        },
        { hasPublishPublicCapability: false }
      )
      audit.objectId = created.id
      recordAudit(req, audit, input.requestId, "ok")
      return success(
        { ...created, url: contentDeepLink(created.slug) },
        input.requestId,
        201
      )
    }

    if (
      input.method === "POST" &&
      segments.length === 2 &&
      segments[1] === "versions"
    ) {
      audit = { action: "create_version", objectId: segments[0] }
      const body = versionSchema.parse(input.body ?? {})
      const created = await contentService.createVersion(req, segments[0], {
        body: decodeContentBody(body.body, body.codeEncoding) ?? body.body,
        bodyFormat: body.bodyFormat,
        summary: body.summary,
      })
      recordAudit(req, audit, input.requestId, "ok")
      return success(created, input.requestId, 201)
    }

    if (input.method === "PATCH" && segments.length === 1) {
      audit = { action: "update", objectId: segments[0] }
      const body = updateSchema.parse(input.body ?? {})
      const collectionId =
        body.collectionId === undefined
          ? undefined
          : body.collectionId === null
            ? null
            : await resolveCollectionId(body.collectionId)
      const updated = await contentService.update(req, segments[0], {
        title: body.title,
        tags: body.tags,
        collectionId,
        status: body.status,
      })
      recordAudit(req, audit, input.requestId, "ok")
      return success(updated, input.requestId)
    }

    if (
      input.method === "PATCH" &&
      segments.length === 2 &&
      segments[1] === "visibility"
    ) {
      audit = { action: "set_visibility", objectId: segments[0] }
      const body = visibilitySchema.parse(input.body ?? {})
      const object = await contentService.loadForEdit(req, segments[0])
      audit.objectId = object.id
      const visibility = await visibilityService.setLevel(
        req,
        object.id,
        body,
        { hasPublishPublicCapability: false }
      )
      recordAudit(req, audit, input.requestId, "ok")
      return success(
        { id: object.id, visibility },
        input.requestId
      )
    }

    if (input.method === "DELETE" && segments.length === 1) {
      audit = { action: "delete", objectId: segments[0] }
      const deleted = await contentService.delete(req, segments[0], {
        surface: "rest",
      })
      return success(deleted, input.requestId)
    }

    if (
      input.method === "POST" &&
      segments.length === 2 &&
      segments[1] === "publish"
    ) {
      const body = publishSchema.parse(input.body ?? {})
      audit = {
        action: "publish",
        objectId: segments[0],
        destination: body.destination,
      }
      const published = await publishService.publish(
        req,
        segments[0],
        {
          destination: body.destination,
          visibility: body.visibility,
        },
        { hasPublishPublicCapability: false }
      )
      recordAudit(req, audit, input.requestId, "ok")
      return success(
        {
          id: segments[0],
          destination: body.destination,
          publishedVersionId: published.publishedVersionId,
        },
        input.requestId
      )
    }

    if (
      input.method === "DELETE" &&
      segments.length === 3 &&
      segments[1] === "publish"
    ) {
      const destination = z
        .enum(["intranet", "public_web", "schoology", "google"])
        .parse(segments[2])
      audit = {
        action: "unpublish",
        objectId: segments[0],
        destination,
      }
      const unpublished = await publishService.unpublish(
        req,
        segments[0],
        destination,
        { hasPublishPublicCapability: false }
      )
      recordAudit(req, audit, input.requestId, "ok")
      return success(
        { id: segments[0], destination, ...unpublished },
        input.requestId
      )
    }

    throw new ForbiddenError("Atrium operation is outside the fixed surface")
  } catch (error) {
    if (error instanceof ApprovalRequiredError && audit) {
      recordAudit(req, audit, input.requestId, "approval_required", error)
      return success(
        { status: "approval_required", message: error.message },
        input.requestId,
        202
      )
    }
    if (audit) recordAudit(req, audit, input.requestId, "error", error)
    if (error instanceof z.ZodError) {
      return {
        httpStatus: 400,
        payload: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid Atrium operation input",
            details: error.issues,
          },
          requestId: input.requestId,
        },
      }
    }
    return contentFailure(error, input.requestId)
  }
}
