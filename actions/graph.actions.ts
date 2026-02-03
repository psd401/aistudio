"use server"

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger"
import {
  handleError,
  ErrorFactories,
  createSuccess,
} from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import {
  queryGraphNodes,
  queryGraphNode,
  insertGraphNode,
  patchGraphNode,
  removeGraphNode,
  queryGraphEdges,
  insertGraphEdge,
  removeGraphEdge,
  queryNodeConnections,
  GraphServiceError,
} from "@/lib/graph"
import type { SelectGraphNode, SelectGraphEdge } from "@/lib/db/types"
import type {
  GraphNodeFilters,
  GraphEdgeFilters,
  CreateNodeInput,
  UpdateNodeInput,
  CreateEdgeInput,
  NodeConnection,
} from "@/lib/graph"

// ============================================
// Node Operations
// ============================================

/**
 * List graph nodes with optional filtering
 */
export async function getGraphNodes(
  filters?: GraphNodeFilters
): Promise<ActionState<SelectGraphNode[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getGraphNodes")
  const log = createLogger({ requestId, action: "getGraphNodes" })

  try {
    log.info("Fetching graph nodes", {
      filters: sanitizeForLogging(filters),
    })

    await requireRole("administrator")

    const result = await queryGraphNodes(filters)

    timer({ status: "success" })
    log.info("Graph nodes retrieved", { count: result.items.length })
    return createSuccess(result.items, `Retrieved ${result.items.length} nodes`)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to retrieve graph nodes", {
      context: "getGraphNodes",
      requestId,
      operation: "getGraphNodes",
    })
  }
}

/**
 * Get a single graph node by ID
 */
export async function getGraphNode(
  nodeId: string
): Promise<ActionState<SelectGraphNode>> {
  const requestId = generateRequestId()
  const timer = startTimer("getGraphNode")
  const log = createLogger({ requestId, action: "getGraphNode" })

  try {
    log.info("Fetching graph node", { nodeId })

    await requireRole("administrator")

    const node = await queryGraphNode(nodeId)

    if (!node) {
      throw ErrorFactories.dbRecordNotFound("graph_nodes", nodeId)
    }

    timer({ status: "success" })
    return createSuccess(node)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to retrieve graph node", {
      context: "getGraphNode",
      requestId,
      operation: "getGraphNode",
      metadata: { nodeId },
    })
  }
}

/**
 * Create a new graph node
 */
export async function createGraphNode(
  input: CreateNodeInput
): Promise<ActionState<SelectGraphNode>> {
  const requestId = generateRequestId()
  const timer = startTimer("createGraphNode")
  const log = createLogger({ requestId, action: "createGraphNode" })

  try {
    log.info("Creating graph node", {
      params: sanitizeForLogging(input),
    })

    const currentUser = await requireRole("administrator")

    if (!input.name?.trim()) {
      throw ErrorFactories.missingRequiredField("name")
    }
    if (!input.nodeType?.trim()) {
      throw ErrorFactories.missingRequiredField("nodeType")
    }
    if (!input.nodeClass?.trim()) {
      throw ErrorFactories.missingRequiredField("nodeClass")
    }

    const newNode = await insertGraphNode(input, currentUser.user.id)

    timer({ status: "success" })
    log.info("Graph node created", { nodeId: newNode.id })
    return createSuccess(newNode, "Node created successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to create graph node", {
      context: "createGraphNode",
      requestId,
      operation: "createGraphNode",
    })
  }
}

/**
 * Update a graph node
 */
export async function updateGraphNode(
  nodeId: string,
  input: UpdateNodeInput
): Promise<ActionState<SelectGraphNode>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateGraphNode")
  const log = createLogger({ requestId, action: "updateGraphNode" })

  try {
    log.info("Updating graph node", {
      nodeId,
      params: sanitizeForLogging(input),
    })

    await requireRole("administrator")

    const updated = await patchGraphNode(nodeId, input)

    if (!updated) {
      throw ErrorFactories.dbRecordNotFound("graph_nodes", nodeId)
    }

    timer({ status: "success" })
    log.info("Graph node updated", { nodeId })
    return createSuccess(updated, "Node updated successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update graph node", {
      context: "updateGraphNode",
      requestId,
      operation: "updateGraphNode",
      metadata: { nodeId },
    })
  }
}

/**
 * Delete a graph node (edges cascade via DB constraint)
 */
export async function deleteGraphNode(
  nodeId: string
): Promise<ActionState<{ deletedId: string }>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteGraphNode")
  const log = createLogger({ requestId, action: "deleteGraphNode" })

  try {
    log.info("Deleting graph node", { nodeId })

    await requireRole("administrator")

    const deleted = await removeGraphNode(nodeId)

    if (!deleted) {
      throw ErrorFactories.dbRecordNotFound("graph_nodes", nodeId)
    }

    timer({ status: "success" })
    log.info("Graph node deleted", { nodeId })
    return createSuccess({ deletedId: nodeId }, "Node deleted successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to delete graph node", {
      context: "deleteGraphNode",
      requestId,
      operation: "deleteGraphNode",
      metadata: { nodeId },
    })
  }
}

// ============================================
// Edge Operations
// ============================================

/**
 * List graph edges with optional filtering
 */
export async function getGraphEdges(
  filters?: GraphEdgeFilters
): Promise<ActionState<SelectGraphEdge[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getGraphEdges")
  const log = createLogger({ requestId, action: "getGraphEdges" })

  try {
    log.info("Fetching graph edges", {
      filters: sanitizeForLogging(filters),
    })

    await requireRole("administrator")

    const result = await queryGraphEdges(filters)

    timer({ status: "success" })
    log.info("Graph edges retrieved", { count: result.items.length })
    return createSuccess(result.items, `Retrieved ${result.items.length} edges`)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to retrieve graph edges", {
      context: "getGraphEdges",
      requestId,
      operation: "getGraphEdges",
    })
  }
}

/**
 * Create a new edge between two nodes
 */
export async function createGraphEdge(
  input: CreateEdgeInput
): Promise<ActionState<SelectGraphEdge>> {
  const requestId = generateRequestId()
  const timer = startTimer("createGraphEdge")
  const log = createLogger({ requestId, action: "createGraphEdge" })

  try {
    log.info("Creating graph edge", {
      params: sanitizeForLogging(input),
    })

    const currentUser = await requireRole("administrator")

    if (!input.sourceNodeId?.trim()) {
      throw ErrorFactories.missingRequiredField("sourceNodeId")
    }
    if (!input.targetNodeId?.trim()) {
      throw ErrorFactories.missingRequiredField("targetNodeId")
    }
    if (!input.edgeType?.trim()) {
      throw ErrorFactories.missingRequiredField("edgeType")
    }
    if (input.sourceNodeId === input.targetNodeId) {
      throw ErrorFactories.invalidInput(
        "targetNodeId",
        input.targetNodeId,
        "Cannot create edge from a node to itself"
      )
    }

    const newEdge = await insertGraphEdge(input, currentUser.user.id)

    timer({ status: "success" })
    log.info("Graph edge created", { edgeId: newEdge.id })
    return createSuccess(newEdge, "Edge created successfully")
  } catch (error) {
    timer({ status: "error" })

    // Translate service errors to user-friendly messages
    if (error instanceof GraphServiceError) {
      if (error.code === "NODE_NOT_FOUND") {
        return handleError(
          ErrorFactories.dbRecordNotFound("graph_nodes", "unknown"),
          "One or more referenced nodes do not exist",
          { context: "createGraphEdge", requestId, operation: "createGraphEdge" }
        )
      }
      if (error.code === "DUPLICATE_EDGE") {
        return handleError(
          ErrorFactories.invalidInput("edge", input.sourceNodeId, error.message),
          error.message,
          { context: "createGraphEdge", requestId, operation: "createGraphEdge" }
        )
      }
    }

    return handleError(error, "Failed to create graph edge", {
      context: "createGraphEdge",
      requestId,
      operation: "createGraphEdge",
    })
  }
}

/**
 * Delete a graph edge
 */
export async function deleteGraphEdge(
  edgeId: string
): Promise<ActionState<{ deletedId: string }>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteGraphEdge")
  const log = createLogger({ requestId, action: "deleteGraphEdge" })

  try {
    log.info("Deleting graph edge", { edgeId })

    await requireRole("administrator")

    const deleted = await removeGraphEdge(edgeId)

    if (!deleted) {
      throw ErrorFactories.dbRecordNotFound("graph_edges", edgeId)
    }

    timer({ status: "success" })
    log.info("Graph edge deleted", { edgeId })
    return createSuccess({ deletedId: edgeId }, "Edge deleted successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to delete graph edge", {
      context: "deleteGraphEdge",
      requestId,
      operation: "deleteGraphEdge",
      metadata: { edgeId },
    })
  }
}

// ============================================
// Query Operations
// ============================================

/**
 * Get all edges connected to a node with resolved node names
 */
export async function getNodeConnections(
  nodeId: string
): Promise<ActionState<NodeConnection[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getNodeConnections")
  const log = createLogger({ requestId, action: "getNodeConnections" })

  try {
    log.info("Fetching node connections", { nodeId })

    await requireRole("administrator")

    const connections = await queryNodeConnections(nodeId)

    timer({ status: "success" })
    log.info("Node connections retrieved", {
      nodeId,
      connectionCount: connections.length,
    })
    return createSuccess(
      connections,
      `Retrieved ${connections.length} connections`
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to retrieve node connections", {
      context: "getNodeConnections",
      requestId,
      operation: "getNodeConnections",
      metadata: { nodeId },
    })
  }
}
