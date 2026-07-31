/**
 * MCP Tool Handlers
 * Thin adapters calling existing service layer functions.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 *
 * Each handler:
 * 1. Validates input
 * 2. Calls the existing service function
 * 3. Returns McpToolResult
 */

import type { McpToolHandler, McpToolResult } from "./types"
import { createLogger } from "@/lib/logger"
import {
  queryGraphNodes,
} from "@/lib/graph/graph-service"
import {
  getDecisionPackage,
  semanticSearchNodes,
} from "@/lib/graph/decision-retrieval"
import {
  captureStructuredDecision,
  createDecisionSchema,
  describeDecisionError,
} from "@/lib/graph/decision-capture-service"
import { isValidationError } from "@/types/error-types"
import {
  executeAssistantForJobCompletion,
  validateExecutionInputs,
} from "@/lib/api/assistant-execution-service"
import { listAccessibleAssistants } from "@/lib/api/assistant-service"
import {
  AssistantImportServiceError,
  createAssistantsFromImport,
  forkAssistant,
  updateAssistantFromImport,
} from "@/lib/assistant-architect/import-service"
import { isAdminByUserId, checkAssistantResourceGrants } from "@/lib/api/route-helpers"
import { getAssistantArchitectByIdAction } from "@/actions/db/assistant-architect-actions"
import { INTERNAL_ASSISTANT_LOOKUP } from "@/lib/assistant-architect/internal-access"
import { AGENT_TOOL_HANDLERS } from "@/lib/agents/agent-tools"
import { CONTENT_TOOL_HANDLERS } from "./content-tool-handlers"
import {
  buildCapabilityCatalog,
  type CapabilityCatalogSection,
} from "@/lib/capabilities/capability-catalog"
import type { ToolSurface } from "@/lib/tools/catalog/types"
import {
  describeRepository,
  getRepositorySource,
  listRepositoryCatalog,
  listRepositoryChanges,
  searchRepositoryCatalog,
} from "@/lib/repositories/repository-catalog-service"
import type {
  RetrievalMode,
  RetrievalModality,
} from "@/lib/repositories/retrieval-v2/types"
import { RepositoryReadinessError } from "@/lib/repositories/readiness-service"

// ============================================
// Handler Map
// ============================================

export const TOOL_HANDLERS: Record<string, McpToolHandler> = {
  describe_capabilities: handleDescribeCapabilities,
  search_decisions: handleSearchDecisions,
  capture_decision: handleCaptureDecision,
  execute_assistant: handleExecuteAssistant,
  create_assistant: handleCreateAssistant,
  update_assistant: handleUpdateAssistant,
  fork_assistant: handleForkAssistant,
  list_assistants: handleListAssistants,
  get_decision_graph: handleGetDecisionGraph,
  repositories_list: handleRepositoriesList,
  repositories_describe: handleRepositoriesDescribe,
  repositories_search: handleRepositoriesSearch,
  repositories_get_source: handleRepositoriesGetSource,
  repositories_list_changes: handleRepositoriesListChanges,
  // Agent platform tools (#926): image gen, web fetch, document gen. Exposed on
  // the `internal` surface only (see lib/tools/catalog/manifest.ts) so they are
  // callable from the agentic Assistant Architect runtime but not the external
  // MCP server.
  ...AGENT_TOOL_HANDLERS,
  // Atrium content tools (Phase 5, Issue #1055): create/get/list/update/version/
  // visibility/publish over the §11–§15 services.
  ...CONTENT_TOOL_HANDLERS,
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : null
}

function positiveIntegerArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value
        .map(positiveInteger)
        .filter((item): item is number => item != null)
    : []
}

function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

function assistantExecutionFailureMessage(error: unknown): string {
  if (isValidationError(error)) {
    const details = error.fields?.map(({ message }) => message).join("; ")
    return details
      ? `Invalid assistant configuration: ${details}`
      : "Invalid assistant configuration"
  }
  return `Assistant execution failed: ${
    error instanceof Error ? error.message : "Unknown error"
  }`
}

async function handleRepositoriesList(
  args: Record<string, unknown>,
  context: { cognitoSub: string }
): Promise<McpToolResult> {
  return jsonResult({
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
  if (!repositoryId) {
    return {
      content: [{ type: "text", text: "Invalid repositoryId" }],
      isError: true,
    }
  }
  const repository = await describeRepository(context.cognitoSub, repositoryId)
  return repository
    ? jsonResult({ repository })
    : {
        content: [{ type: "text", text: "Repository not found" }],
        isError: true,
      }
}

async function handleRepositoriesSearch(
  args: Record<string, unknown>,
  context: { cognitoSub: string }
): Promise<McpToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : ""
  if (!query) {
    return {
      content: [{ type: "text", text: "query is required" }],
      isError: true,
    }
  }
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
    return jsonResult(
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
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error.code,
            message: error.message,
            repositories: error.repositories,
          }),
        },
      ],
      isError: true,
    }
  }
}

async function handleRepositoriesGetSource(
  args: Record<string, unknown>,
  context: { userId: number }
): Promise<McpToolResult> {
  const repositoryId = positiveInteger(args.repositoryId)
  const itemId = positiveInteger(args.itemId)
  if (!repositoryId || !itemId) {
    return {
      content: [
        { type: "text", text: "Valid repositoryId and itemId are required" },
      ],
      isError: true,
    }
  }
  return jsonResult({
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
  if (repositoryIds.length === 0) {
    return {
      content: [{ type: "text", text: "repositoryIds is required" }],
      isError: true,
    }
  }
  return jsonResult(
    await listRepositoryChanges({
      userId: context.userId,
      repositoryIds,
      cursor: typeof args.cursor === "string" ? args.cursor : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    })
  )
}

// ============================================
// describe_capabilities (Issue #1100)
// ============================================

const CATALOG_SECTIONS: readonly CapabilityCatalogSection[] = [
  "actions",
  "features",
  "scopes",
  "all",
]
const CATALOG_SURFACES: readonly ToolSurface[] = [
  "mcp",
  "ai_sdk",
  "rest",
  "internal",
]

/**
 * Live projection of AI Studio's own registries (Issue #1100). Reads the
 * capability builder ON EVERY CALL so the result always reflects the deployed
 * code — the freshness guarantee. Pure/read-only: no auth beyond the
 * `platform:read` scope the catalog already enforced before dispatch. Unknown
 * `section`/`surface` values are ignored (fall back to the builder defaults)
 * rather than erroring, so a slightly-off client argument still returns a useful
 * catalog.
 */
async function handleDescribeCapabilities(
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  // Defensive: the MCP dispatcher always passes a sanitized object, but guard
  // against a null/undefined args from any future internal caller.
  const safeArgs = args ?? {}
  const section =
    typeof safeArgs.section === "string" &&
    CATALOG_SECTIONS.includes(safeArgs.section as CapabilityCatalogSection)
      ? (safeArgs.section as CapabilityCatalogSection)
      : undefined
  const surface =
    typeof safeArgs.surface === "string" &&
    CATALOG_SURFACES.includes(safeArgs.surface as ToolSurface)
      ? (safeArgs.surface as ToolSurface)
      : undefined
  const query =
    typeof safeArgs.query === "string" && safeArgs.query.trim().length > 0
      ? safeArgs.query
      : undefined

  const catalog = buildCapabilityCatalog({ section, surface, query })

  return {
    content: [{ type: "text", text: JSON.stringify(catalog) }],
  }
}

// ============================================
// search_decisions
// ============================================

async function handleSearchDecisions(
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const log = createLogger({ action: "mcp.search_decisions" })
  const limit = typeof args.limit === "number" ? args.limit : 50
  const nodeType = typeof args.nodeType === "string" ? args.nodeType : undefined
  const nodeClass = typeof args.nodeClass === "string" ? args.nodeClass : undefined

  // Semantic path (Issue #1252): a non-empty `q` triggers embedding-based
  // paraphrase search over decision nodes. Degrades to lexical ILIKE search on
  // the same text if the embedding call fails — never a hard error.
  const q = typeof args.q === "string" && args.q.trim().length > 0 ? args.q.trim() : undefined
  if (q) {
    try {
      const matches = await semanticSearchNodes(q, {
        limit,
        // `search_decisions` defaults to decision nodes; an explicit nodeType overrides.
        nodeType: nodeType ?? "decision",
        // The lexical branch honors nodeClass, so the semantic branch must too.
        nodeClass,
      })
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              nodes: matches.map((m) => ({
                id: m.id,
                name: m.name,
                nodeType: m.nodeType,
                nodeClass: m.nodeClass,
                description: m.description,
                status: m.status,
                similarity: m.similarity,
              })),
              method: "semantic",
            }),
          },
        ],
      }
    } catch (error) {
      log.warn("Semantic search failed, falling back to lexical", {
        error: error instanceof Error ? error.message : String(error),
      })
      // fall through to lexical search using `q` as the ILIKE term
    }
  }

  return searchDecisionsLexical(args, { q, nodeType, nodeClass, limit })
}

/** Lexical (ILIKE) leg of search_decisions — direct `query` or semantic fallback. */
async function searchDecisionsLexical(
  args: Record<string, unknown>,
  params: { q?: string; nodeType?: string; nodeClass?: string; limit: number }
): Promise<McpToolResult> {
  const { q, nodeType, nodeClass, limit } = params

  const result = await queryGraphNodes(
    {
      search:
        q ?? (typeof args.query === "string" ? args.query : undefined),
      // The semantic branch scopes to decisions by default; its lexical
      // FALLBACK must keep that scope or an embedding outage silently widens
      // results to every node type. A plain `query` (no `q`) keeps the
      // historical un-scoped behavior.
      nodeType: q ? (nodeType ?? "decision") : nodeType,
      nodeClass,
    },
    {
      limit,
      cursor: typeof args.cursor === "string" ? args.cursor : undefined,
    }
  )

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          nodes: result.items.map((n) => ({
            id: n.id,
            name: n.name,
            nodeType: n.nodeType,
            nodeClass: n.nodeClass,
            description: n.description,
            status: n.status,
            createdAt: n.createdAt,
          })),
          nextCursor: result.nextCursor,
          method: q ? "lexical-fallback" : "lexical",
        }),
      },
    ],
  }
}

// ============================================
// capture_decision
// ============================================

async function handleCaptureDecision(
  args: Record<string, unknown>,
  context: { userId: number; cognitoSub: string; scopes: string[]; requestId: string }
): Promise<McpToolResult> {
  const log = createLogger({ requestId: context.requestId, action: "mcp.capture_decision" })

  // Validate input with shared Zod schema
  const parsed = createDecisionSchema.safeParse(args)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    return {
      content: [{ type: "text", text: `Validation failed: ${issues}` }],
      isError: true,
    }
  }

  try {
    const result = await captureStructuredDecision(parsed.data, context.userId, context.requestId)

    log.info("Structured decision captured via MCP", {
      decisionNodeId: result.decisionNodeId,
      nodesCreated: result.nodesCreated,
      edgesCreated: result.edgesCreated,
      completenessScore: result.completenessScore,
    })

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            decisionNodeId: result.decisionNodeId,
            nodesCreated: result.nodesCreated,
            edgesCreated: result.edgesCreated,
            completenessScore: result.completenessScore,
            completenessMethod: result.completenessMethod,
            ...(result.warnings.length > 0 && { warnings: result.warnings }),
          }),
        },
      ],
    }
  } catch (error) {
    // describeDecisionError surfaces the specific field messages (off-vocabulary
    // type, self-referencing edge, duplicate edge) instead of the generic
    // "Validation failed for N field(s)" — and never a raw Postgres string.
    if (isValidationError(error)) {
      const message = describeDecisionError(error)
      log.warn("capture_decision validation failed", { error: message })
      return {
        content: [{ type: "text", text: `Validation error: ${message}` }],
        isError: true,
      }
    }
    log.error("capture_decision failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      content: [{ type: "text", text: `Failed to capture decision: ${describeDecisionError(error)}` }],
      isError: true,
    }
  }
}

function assistantImportEnvelope(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: args.version,
    exported_at: args.exported_at,
    export_source: args.export_source,
    assistants: args.assistants,
  }
}

function assistantMutationError(
  action: "create" | "update" | "fork",
  error: unknown,
): McpToolResult {
  const message =
    error instanceof AssistantImportServiceError
      ? error.message
      : `Failed to ${action} assistant`
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  }
}

// ============================================
// execute_assistant
// ============================================

function storedPromptModelGrantIds(architect: {
  modelRoutingMode?: string | null
  prompts?: Array<{ modelId?: number | null }> | null
}): number[] {
  if ((architect.modelRoutingMode ?? "legacy") !== "legacy") return []
  return (architect.prompts ?? [])
    .map((prompt) => prompt.modelId)
    .filter(
      (modelId): modelId is number =>
        typeof modelId === "number" && modelId > 0
    )
}

async function handleExecuteAssistant(
  args: Record<string, unknown>,
  context: { userId: number; cognitoSub: string; scopes: string[]; requestId: string }
): Promise<McpToolResult> {
  const log = createLogger({ requestId: context.requestId, action: "mcp.execute_assistant" })

  const assistantId = args.assistantId as number
  const inputs = (args.inputs as Record<string, unknown>) ?? {}

  if (!assistantId || typeof assistantId !== "number") {
    return {
      content: [{ type: "text", text: "Missing or invalid required field: assistantId (number)" }],
      isError: true,
    }
  }

  // Same input limits REST enforces (100 KB, 50 fields, object shape) — the v1
  // execute route runs validateExecutionInputs before the service, so the MCP
  // surface must too or a key could create oversized execution records here
  // that the identical REST call rejects.
  const inputErrors = validateExecutionInputs(inputs)
  if (inputErrors) {
    log.warn("execute_assistant inputs failed validation", {
      assistantId,
      issueCount: inputErrors.length,
    })
    return {
      content: [
        {
          type: "text",
          text: `Invalid inputs: ${inputErrors.map((i) => i.message).join("; ")}`,
        },
      ],
      isError: true,
    }
  }

  // Per-resource grant enforcement (#1206): REST execution verifies assistant +
  // model grants at the route (app/api/v1/assistants/[id]/execute), and MCP must
  // enforce the SAME gate — otherwise a staff key holding mcp:execute_assistant
  // could run a restricted assistant the identical REST call would 403. A failed
  // architect load is deliberately NOT handled here: executeAssistantForJobCompletion
  // produces the canonical "Record not found in assistant_architects" error that
  // agent clients (psd-aistudio) map to a clean not_executable result, and that
  // wire contract must not change.
  const architectResult = await getAssistantArchitectByIdAction(
    String(assistantId),
    INTERNAL_ASSISTANT_LOOKUP
  )
  if (architectResult.isSuccess && architectResult.data) {
    const architect = architectResult.data
    const check = await checkAssistantResourceGrants({
      userId: context.userId,
      architectUserId: architect.userId,
      architectId: architect.id,
      modelDbIds: storedPromptModelGrantIds(architect),
    })
    if (!check.granted) {
      log.warn("execute_assistant denied by per-resource grant", {
        assistantId,
        userId: context.userId,
        reason: check.reason,
        ...(check.deniedModelIds && { deniedModelIds: check.deniedModelIds }),
      })
      return {
        content: [
          {
            type: "text",
            text:
              check.reason === "assistant"
                ? "You do not have access to this assistant"
                : "You do not have access to a model this assistant uses",
          },
        ],
        isError: true,
      }
    }
  }

  try {
    const result = await executeAssistantForJobCompletion({
      assistantId,
      inputs,
      userId: context.userId,
      cognitoSub: context.cognitoSub,
      requestId: context.requestId,
      requireApproved: true,
    })

    log.info("Assistant executed via MCP", {
      assistantId,
      executionId: result.executionId,
    })

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            executionId: result.executionId,
            text: result.text,
            usage: result.usage ?? null,
          }),
        },
      ],
    }
  } catch (error) {
    log.error("execute_assistant failed", {
      assistantId,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      content: [
        {
          type: "text",
          text: assistantExecutionFailureMessage(error),
        },
      ],
      isError: true,
    }
  }
}

// ============================================
// create_assistant / update_assistant / fork_assistant
// ============================================

async function handleCreateAssistant(
  args: Record<string, unknown>,
  context: { userId: number; requestId: string },
): Promise<McpToolResult> {
  const log = createLogger({
    requestId: context.requestId,
    action: "mcp.create_assistant",
  })
  try {
    const result = await createAssistantsFromImport(
      assistantImportEnvelope(args),
      context.userId,
    )
    if (result.successful === 0) {
      log.error("Assistant import created no assistants via MCP", {
        userId: context.userId,
        failed: result.failed,
      })
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ data: result }),
          },
        ],
        isError: true,
      }
    }
    log.info("Assistants created via MCP", {
      userId: context.userId,
      successful: result.successful,
      failed: result.failed,
    })
    return jsonResult({ data: result })
  } catch (error) {
    log.warn("create_assistant failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return assistantMutationError("create", error)
  }
}

async function handleUpdateAssistant(
  args: Record<string, unknown>,
  context: { userId: number; requestId: string },
): Promise<McpToolResult> {
  const assistantId = positiveInteger(args.assistantId)
  if (!assistantId) {
    return {
      content: [
        {
          type: "text",
          text: "Missing or invalid required field: assistantId (number)",
        },
      ],
      isError: true,
    }
  }

  const log = createLogger({
    requestId: context.requestId,
    action: "mcp.update_assistant",
  })
  try {
    const result = await updateAssistantFromImport(
      assistantId,
      assistantImportEnvelope(args),
      context.userId,
    )
    log.info("Assistant updated via MCP", {
      assistantId,
      userId: context.userId,
    })
    return jsonResult({ data: result })
  } catch (error) {
    log.warn("update_assistant failed", {
      assistantId,
      error: error instanceof Error ? error.message : String(error),
    })
    return assistantMutationError("update", error)
  }
}

async function handleForkAssistant(
  args: Record<string, unknown>,
  context: { userId: number; requestId: string },
): Promise<McpToolResult> {
  const assistantId = positiveInteger(args.assistantId)
  if (!assistantId) {
    return {
      content: [
        {
          type: "text",
          text: "Missing or invalid required field: assistantId (number)",
        },
      ],
      isError: true,
    }
  }
  if (
    args.name !== undefined &&
    (typeof args.name !== "string" ||
      args.name.length === 0 ||
      args.name.length > 255)
  ) {
    return {
      content: [
        {
          type: "text",
          text: "name must be a non-empty string up to 255 characters",
        },
      ],
      isError: true,
    }
  }

  const log = createLogger({
    requestId: context.requestId,
    action: "mcp.fork_assistant",
  })
  try {
    const result = await forkAssistant(
      assistantId,
      context.userId,
      typeof args.name === "string" ? args.name : undefined,
    )
    log.info("Assistant forked via MCP", {
      sourceAssistantId: assistantId,
      forkAssistantId: result.result.id,
      userId: context.userId,
    })
    return jsonResult({
      data: {
        ...result,
        sourceAssistantId: assistantId,
      },
    })
  } catch (error) {
    log.warn("fork_assistant failed", {
      sourceAssistantId: assistantId,
      error: error instanceof Error ? error.message : String(error),
    })
    return assistantMutationError("fork", error)
  }
}

// ============================================
// list_assistants
// ============================================

async function handleListAssistants(
  args: Record<string, unknown>,
  context: { userId: number; cognitoSub: string; scopes: string[]; requestId: string }
): Promise<McpToolResult> {
  const isAdmin = await isAdminByUserId(context.userId)

  const result = await listAccessibleAssistants(context.userId, isAdmin, {
    limit: typeof args.limit === "number" ? args.limit : 50,
    cursor: typeof args.cursor === "string" ? args.cursor : undefined,
    status: typeof args.status === "string" ? args.status : undefined,
    search: typeof args.search === "string" ? args.search : undefined,
  })

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          assistants: result.items,
          nextCursor: result.nextCursor,
        }),
      },
    ],
  }
}

// ============================================
// get_decision_graph
// ============================================

async function handleGetDecisionGraph(
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const nodeId = args.nodeId as string

  if (!nodeId || typeof nodeId !== "string") {
    return {
      content: [{ type: "text", text: "Missing required field: nodeId" }],
      isError: true,
    }
  }

  // Decision-package retrieval (Issue #1252): the decision plus its evidence,
  // constraints, reasoning, persons, conditions, outcomes, and supersession
  // chain via a depth-bounded, cycle-safe recursive CTE — one self-contained
  // response instead of a single 1-hop connection list.
  const depth = typeof args.depth === "number" ? args.depth : undefined
  const pkg = await getDecisionPackage(nodeId, { maxDepth: depth })

  if (!pkg) {
    return {
      content: [{ type: "text", text: `Node not found: ${nodeId}` }],
      isError: true,
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          decision: pkg.decision,
          persons: pkg.persons,
          evidence: pkg.evidence,
          constraints: pkg.constraints,
          reasoning: pkg.reasoning,
          conditions: pkg.conditions,
          outcomes: pkg.outcomes,
          policies: pkg.policies,
          edges: pkg.edges,
          supersessionChain: pkg.supersessionChain,
          depth: pkg.depth,
        }),
      },
    ],
  }
}
