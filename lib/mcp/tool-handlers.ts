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
  insertGraphNode,
  insertGraphEdge,
  GraphServiceError,
} from "@/lib/graph/graph-service"
import { executeAssistantForJobCompletion } from "@/lib/api/assistant-execution-service"
import { listAccessibleAssistants } from "@/lib/api/assistant-service"
import { isAdminByUserId } from "@/lib/api/route-helpers"

// ============================================
// Handler Map
// ============================================

export const TOOL_HANDLERS: Record<string, McpToolHandler> = {
  search_decisions: handleSearchDecisions,
  capture_decision: handleCaptureDecision,
  execute_assistant: handleExecuteAssistant,
  list_assistants: handleListAssistants,
  get_decision_graph: handleGetDecisionGraph,
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

  const name = args.name as string
  const nodeType = args.nodeType as string
  const nodeClass = args.nodeClass as string
  const description = typeof args.description === "string" ? args.description : undefined

  if (!name || !nodeType || !nodeClass) {
    return {
      content: [{ type: "text", text: "Missing required fields: name, nodeType, nodeClass" }],
      isError: true,
    }
  }

  try {
    const node = await insertGraphNode(
      { name, nodeType, nodeClass, description },
      context.userId
    )

    log.info("Decision node created via MCP", { nodeId: node.id })

    // Optionally create an edge
    let edge = null
    if (typeof args.linkedNodeId === "string" && typeof args.edgeType === "string") {
      try {
        edge = await insertGraphEdge(
          {
            sourceNodeId: node.id,
            targetNodeId: args.linkedNodeId,
            edgeType: args.edgeType,
          },
          context.userId
        )
        log.info("Decision edge created via MCP", { edgeId: edge.id })
      } catch (edgeError) {
        if (edgeError instanceof GraphServiceError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  node: { id: node.id, name: node.name },
                  edgeError: edgeError.message,
                }),
              },
            ],
          }
        }
        throw edgeError
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            node: { id: node.id, name: node.name, nodeType: node.nodeType },
            edge: edge ? { id: edge.id, edgeType: edge.edgeType } : null,
          }),
        },
      ],
    }
  } catch (error) {
    log.error("capture_decision failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      content: [{ type: "text", text: `Failed to capture decision: ${error instanceof Error ? error.message : "Unknown error"}` }],
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
