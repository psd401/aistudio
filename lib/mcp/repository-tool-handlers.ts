/**
 * Repository MCP tool handlers.
 *
 * Read side (#1266): list / describe / search / get_source / list_changes over
 * `lib/repositories/repository-catalog-service`.
 * Write side (#1907): create / add_item over
 * `lib/repositories/repository-write-service`.
 *
 * Split out of `lib/mcp/tool-handlers.ts` with #1907 — same move
 * `content-tool-handlers.ts` made once the Atrium domain grew — so this domain's
 * handlers, its validation schemas, and its authorization helper live together
 * instead of being appended to a file that already carries decisions, assistant
 * CRUD, and the capability catalog.
 *
 * Validation is Zod, matching `content-tool-handlers.ts` rather than inventing a
 * second idiom inside `lib/mcp`. Bounds are the shared ones from the write
 * service, so MCP and any future surface reject oversized input against ONE
 * definition.
 *
 * ## Authorization
 *
 * Scopes are enforced by the unified tool catalog's `dispatch()` (each catalog
 * entry's `requiredScopes`, #924) BEFORE these run. The scope is necessary but
 * NOT sufficient for the write tools: an OAuth access token's scopes come from
 * the grant, not from the holder's roles (`lib/api/auth-middleware.ts` reads
 * `payload.scope` verbatim), so a student who authorized the first-party agent
 * client would carry `repositories:create` without the UI ever letting them
 * create a repository. Every write therefore re-checks the live
 * `knowledge-repositories` capability against the caller's own roles, and
 * `add_item` additionally re-checks ownership of the target repository.
 */

import { z } from "zod"
import {
  createRepository as createRepositoryRow,
  hasCapabilityAccess as dbHasCapabilityAccess,
} from "@/lib/db/drizzle"
import {
  describeRepository,
  getRepositorySource,
  listRepositoryCatalog,
  listRepositoryChanges,
  searchRepositoryCatalog,
} from "@/lib/repositories/repository-catalog-service"
import {
  createRepositoryTextItem,
  REPOSITORY_DESCRIPTION_MAX_BYTES,
  REPOSITORY_INLINE_TEXT_MAX_BYTES,
  REPOSITORY_NAME_MAX_BYTES,
} from "@/lib/repositories/repository-write-service"
import { canModifyUserManagedDurableRepository } from "@/lib/repositories/repository-permissions"
import { RepositoryReadinessError } from "@/lib/repositories/readiness-service"
import type {
  RetrievalMode,
  RetrievalModality,
} from "@/lib/repositories/retrieval-v2/types"
import type { McpToolHandler, McpToolResult } from "./types"

// ============================================
// Result + validation helpers
// ============================================

function ok(payload: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] }
}

function toolError(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true }
}

function zodFail(error: z.ZodError): McpToolResult {
  const issues = error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ")
  return toolError(`Validation failed: ${issues}`)
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null
}

function positiveIntegerArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(positiveInteger).filter((item): item is number => item != null)
    : []
}

/**
 * A trimmed, non-empty string bounded in UTF-8 BYTES.
 *
 * Byte-bounded rather than `.max(n)` (which counts UTF-16 code units) so a CJK
 * or emoji name cannot carry up to 4x the intended footprint into an unbounded
 * `text` column — the same reasoning the inline-content cap uses.
 */
function boundedText(maxBytes: number) {
  return z
    .string()
    .trim()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, {
      message: `must not exceed ${maxBytes} bytes`,
    })
}

const createRepositorySchema = z.object({
  name: boundedText(REPOSITORY_NAME_MAX_BYTES),
  description: boundedText(REPOSITORY_DESCRIPTION_MAX_BYTES).optional(),
})

const addItemSchema = z.object({
  name: boundedText(REPOSITORY_NAME_MAX_BYTES),
  // NOT trimmed: the caller's text is stored verbatim, leading indentation and
  // all. Only the emptiness check looks past whitespace.
  content: z
    .string()
    .refine((value) => value.trim().length > 0, {
      message: "must not be blank",
    })
    .refine(
      (value) =>
        Buffer.byteLength(value, "utf8") <= REPOSITORY_INLINE_TEXT_MAX_BYTES,
      {
        message: `must not exceed ${REPOSITORY_INLINE_TEXT_MAX_BYTES} bytes`,
      }
    ),
})

/** The UI capability that gates Repository Manager for a signed-in human. */
const REPOSITORY_CAPABILITY = "knowledge-repositories"

/** The capability half of the repository write gate — see the module header. */
async function assertRepositoryCapability(
  cognitoSub: string
): Promise<McpToolResult | null> {
  const allowed = await dbHasCapabilityAccess(cognitoSub, REPOSITORY_CAPABILITY)
  return allowed
    ? null
    : toolError(
        "Your account does not have access to knowledge repositories in AI Studio"
      )
}

// ============================================
// Reads (#1266)
// ============================================

async function handleRepositoriesList(
  args: Record<string, unknown>,
  context: { cognitoSub: string }
): Promise<McpToolResult> {
  return ok({
    repositories: await listRepositoryCatalog(context.cognitoSub, {
      query: typeof args.query === "string" ? args.query : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    }),
  })
}

async function handleRepositoriesDescribe(
  args: Record<string, unknown>,
  context: { cognitoSub: string }
): Promise<McpToolResult> {
  const repositoryId = positiveInteger(args.repositoryId)
  if (!repositoryId) return toolError("Invalid repositoryId")

  const repository = await describeRepository(context.cognitoSub, repositoryId)
  return repository ? ok({ repository }) : toolError("Repository not found")
}

async function handleRepositoriesSearch(
  args: Record<string, unknown>,
  context: { cognitoSub: string }
): Promise<McpToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : ""
  if (!query) return toolError("query is required")

  const allowedModes: RetrievalMode[] = ["keyword", "vector", "hybrid"]
  const allowedModalities: RetrievalModality[] = [
    "text",
    "image",
    "audio",
    "video",
    "table",
  ]
  const mode =
    typeof args.mode === "string" &&
    allowedModes.includes(args.mode as RetrievalMode)
      ? (args.mode as RetrievalMode)
      : undefined
  const modalities = Array.isArray(args.modalities)
    ? args.modalities.filter(
        (value): value is RetrievalModality =>
          typeof value === "string" &&
          allowedModalities.includes(value as RetrievalModality)
      )
    : undefined
  try {
    return ok(
      await searchRepositoryCatalog({
        cognitoSub: context.cognitoSub,
        query,
        repositoryIds: positiveIntegerArray(args.repositoryIds),
        mode,
        modalities,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      })
    )
  } catch (error) {
    if (!(error instanceof RepositoryReadinessError)) throw error
    return toolError(
      JSON.stringify({
        error: error.code,
        message: error.message,
        repositories: error.repositories,
      })
    )
  }
}

async function handleRepositoriesGetSource(
  args: Record<string, unknown>,
  context: { userId: number }
): Promise<McpToolResult> {
  const repositoryId = positiveInteger(args.repositoryId)
  const itemId = positiveInteger(args.itemId)
  if (!repositoryId || !itemId) {
    return toolError("Valid repositoryId and itemId are required")
  }
  return ok({
    segments: await getRepositorySource({
      userId: context.userId,
      repositoryId,
      itemId,
      chunkId: positiveInteger(args.chunkId) ?? undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    }),
  })
}

async function handleRepositoriesListChanges(
  args: Record<string, unknown>,
  context: { userId: number }
): Promise<McpToolResult> {
  const repositoryIds = positiveIntegerArray(args.repositoryIds)
  if (repositoryIds.length === 0) return toolError("repositoryIds is required")

  return ok(
    await listRepositoryChanges({
      userId: context.userId,
      repositoryIds,
      cursor: typeof args.cursor === "string" ? args.cursor : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    })
  )
}

// ============================================
// Writes (#1907)
// ============================================

async function handleRepositoriesCreate(
  args: Record<string, unknown>,
  context: { cognitoSub: string; userId: number }
): Promise<McpToolResult> {
  // Shape first: a malformed call must not be usable to probe anything.
  const parsed = createRepositorySchema.safeParse(args)
  if (!parsed.success) return zodFail(parsed.error)

  const capabilityError = await assertRepositoryCapability(context.cognitoSub)
  if (capabilityError) return capabilityError

  // Private by default and owned by the caller. A repository created over MCP is
  // deliberately NOT public: widening visibility stays a human decision in the
  // Repository Manager UI, so an agent cannot publish a knowledge base
  // district-wide on its own.
  const repository = await createRepositoryRow({
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    ownerId: context.userId,
    isPublic: false,
  })

  return ok({
    repository: {
      id: repository.id,
      name: repository.name,
      description: repository.description,
      visibility: repository.isPublic ? "public" : "private",
      repositoryKind: repository.repositoryKind,
      createdAt: repository.createdAt?.toISOString() ?? null,
    },
  })
}

async function handleRepositoriesAddItem(
  args: Record<string, unknown>,
  context: { cognitoSub: string; userId: number; requestId: string }
): Promise<McpToolResult> {
  const repositoryId = positiveInteger(args.repositoryId)
  if (!repositoryId) return toolError("Valid repositoryId is required")

  const parsed = addItemSchema.safeParse(args)
  if (!parsed.success) return zodFail(parsed.error)

  const capabilityError = await assertRepositoryCapability(context.cognitoSub)
  if (capabilityError) return capabilityError

  // Live ACL check against the SAME boundary the REST upload routes use: owner
  // or administrator, durable + user-managed only. It masks an absent, deleted,
  // ephemeral, or system-managed (Atrium index) repository as "not found" so the
  // tool never confirms that an id the caller cannot touch exists.
  if (
    !(await canModifyUserManagedDurableRepository(repositoryId, context.userId))
  ) {
    return toolError("Repository not found")
  }

  const item = await createRepositoryTextItem({
    repositoryId,
    userId: context.userId,
    name: parsed.data.name,
    content: parsed.data.content,
    traceId: context.requestId,
    callerAction: "repositories_add_item",
  })

  return ok({
    item: {
      id: item.id,
      repositoryId: item.repositoryId,
      name: item.name,
      type: item.type,
      processingStatus: item.processingStatus,
      createdAt: item.createdAt?.toISOString() ?? null,
    },
    // Stated explicitly so an agent cannot read a successful add as "this is in
    // the index now". Ingestion is asynchronous, and after the Repository
    // Manager cutover the canonical generation is the ONLY searchable copy, so
    // an immediate repositories_search would miss content that was accepted.
    searchable: item.processingStatus === "completed",
    note:
      item.processingStatus === "completed"
        ? "Item is indexed and searchable now."
        : "Item accepted. It is NOT searchable yet — ingestion and embedding run asynchronously. Re-check with repositories_describe before relying on repositories_search to find it.",
  })
}

export const REPOSITORY_TOOL_HANDLERS: Record<string, McpToolHandler> = {
  repositories_list: handleRepositoriesList,
  repositories_describe: handleRepositoriesDescribe,
  repositories_search: handleRepositoriesSearch,
  repositories_get_source: handleRepositoriesGetSource,
  repositories_list_changes: handleRepositoriesListChanges,
  repositories_create: handleRepositoriesCreate,
  repositories_add_item: handleRepositoriesAddItem,
}
