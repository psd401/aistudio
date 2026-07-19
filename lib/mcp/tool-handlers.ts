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
  queryGraphNode,
  queryNodeConnections,
} from "@/lib/graph/graph-service"
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
import { isAdminByUserId, checkAssistantResourceGrants } from "@/lib/api/route-helpers"
import { getAssistantArchitectByIdAction } from "@/actions/db/assistant-architect-actions"
import { AGENT_TOOL_HANDLERS } from "@/lib/agents/agent-tools"
import { CONTENT_TOOL_HANDLERS } from "./content-tool-handlers"
import {
  buildCapabilityCatalog,
  type CapabilityCatalogSection,
} from "@/lib/capabilities/capability-catalog"
import type { ToolSurface } from "@/lib/tools/catalog/types"

// ============================================
// Handler Map
// ============================================

export const TOOL_HANDLERS: Record<string, McpToolHandler> = {
  describe_capabilities: handleDescribeCapabilities,
  search_decisions: handleSearchDecisions,
  capture_decision: handleCaptureDecision,
  execute_assistant: handleExecuteAssistant,
  list_assistants: handleListAssistants,
  get_decision_graph: handleGetDecisionGraph,
  // Agent platform tools (#926): image gen, web fetch, document gen. Exposed on
  // the `internal` surface only (see lib/tools/catalog/manifest.ts) so they are
  // callable from the agentic Assistant Architect runtime but not the external
  // MCP server.
  ...AGENT_TOOL_HANDLERS,
  // Atrium content tools (Phase 5, Issue #1055): create/get/list/update/version/
  // visibility/publish over the §11–§15 services.
  ...CONTENT_TOOL_HANDLERS,
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
  const result = await queryGraphNodes(
    {
      search: typeof args.query === "string" ? args.query : undefined,
      nodeType: typeof args.nodeType === "string" ? args.nodeType : undefined,
      nodeClass: typeof args.nodeClass === "string" ? args.nodeClass : undefined,
    },
    {
      limit: typeof args.limit === "number" ? args.limit : 50,
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
            createdAt: n.createdAt,
          })),
          nextCursor: result.nextCursor,
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

// ============================================
// execute_assistant
// ============================================

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
  const architectResult = await getAssistantArchitectByIdAction(String(assistantId))
  if (architectResult.isSuccess && architectResult.data) {
    const architect = architectResult.data
    const check = await checkAssistantResourceGrants({
      userId: context.userId,
      architectUserId: architect.userId,
      architectId: architect.id,
      modelDbIds: (architect.prompts || [])
        .map((p) => p.modelId)
        .filter((m): m is number => typeof m === "number" && m > 0),
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
        { type: "text", text: `Assistant execution failed: ${error instanceof Error ? error.message : "Unknown error"}` },
      ],
      isError: true,
    }
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

  const [node, connections] = await Promise.all([
    queryGraphNode(nodeId),
    queryNodeConnections(nodeId),
  ])

  if (!node) {
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
          node: {
            id: node.id,
            name: node.name,
            nodeType: node.nodeType,
            nodeClass: node.nodeClass,
            description: node.description,
            metadata: node.metadata,
            createdAt: node.createdAt,
          },
          connections: connections.map((c) => ({
            direction: c.direction,
            edgeType: c.edge.edgeType,
            connectedNode: c.connectedNode,
          })),
        }),
      },
    ],
  }
}
