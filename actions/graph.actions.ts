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
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, or, ilike, and, desc, inArray, type SQL } from "drizzle-orm"
import { graphNodes, graphEdges } from "@/lib/db/schema"
import type {
  SelectGraphNode,
  SelectGraphEdge,
  GraphNodeMetadata,
  GraphEdgeMetadata,
} from "@/lib/db/types"

// ============================================
// Input Types
// ============================================

export interface GraphNodeFilters {
  nodeType?: string
  nodeClass?: string
  search?: string
}

export interface CreateGraphNodeInput {
  name: string
  nodeType: string
  nodeClass: string
  description?: string
  metadata?: GraphNodeMetadata
}

export interface UpdateGraphNodeInput {
  name?: string
  nodeType?: string
  nodeClass?: string
  description?: string | null
  metadata?: GraphNodeMetadata
}

export interface GraphEdgeFilters {
  edgeType?: string
  sourceNodeId?: string
  targetNodeId?: string
}

export interface CreateGraphEdgeInput {
  sourceNodeId: string
  targetNodeId: string
  edgeType: string
  metadata?: GraphEdgeMetadata
}

export interface NodeConnection {
  edge: SelectGraphEdge
  connectedNode: {
    id: string
    name: string
    nodeType: string
    nodeClass: string
  }
  direction: "outgoing" | "incoming"
}

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

    const conditions: SQL[] = []

    if (filters?.nodeType) {
      conditions.push(eq(graphNodes.nodeType, filters.nodeType))
    }
    if (filters?.nodeClass) {
      conditions.push(eq(graphNodes.nodeClass, filters.nodeClass))
    }
    if (filters?.search) {
      conditions.push(
        or(
          ilike(graphNodes.name, `%${filters.search}%`),
          ilike(graphNodes.description, `%${filters.search}%`)
        )!
      )
    }

    const nodes = await executeQuery(
      (db) => {
        const query = db.select().from(graphNodes)
        if (conditions.length > 0) {
          return query.where(and(...conditions)).orderBy(desc(graphNodes.createdAt))
        }
        return query.orderBy(desc(graphNodes.createdAt))
      },
      "getGraphNodes"
    )

    timer({ status: "success" })
    log.info("Graph nodes retrieved", { count: nodes.length })
    return createSuccess(nodes, `Retrieved ${nodes.length} nodes`)
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

    const [node] = await executeQuery(
      (db) =>
        db
          .select()
          .from(graphNodes)
          .where(eq(graphNodes.id, nodeId))
          .limit(1),
      "getGraphNode"
    )

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
  input: CreateGraphNodeInput
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

    const [newNode] = await executeQuery(
      (db) =>
        db
          .insert(graphNodes)
          .values({
            name: input.name.trim(),
            nodeType: input.nodeType.trim(),
            nodeClass: input.nodeClass.trim(),
            description: input.description?.trim() || null,
            metadata: input.metadata ?? {},
            createdBy: currentUser.user.id,
          })
          .returning(),
      "createGraphNode"
    )

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
  input: UpdateGraphNodeInput
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

    // Build set clause with only provided fields
    const setValues: Record<string, unknown> = {
      updatedAt: new Date(),
    }
    if (input.name !== undefined) setValues.name = input.name.trim()
    if (input.nodeType !== undefined) setValues.nodeType = input.nodeType.trim()
    if (input.nodeClass !== undefined) setValues.nodeClass = input.nodeClass.trim()
    if (input.description !== undefined) {
      setValues.description = input.description === null ? null : input.description.trim()
    }
    if (input.metadata !== undefined) setValues.metadata = input.metadata

    const [updated] = await executeQuery(
      (db) =>
        db
          .update(graphNodes)
          .set(setValues)
          .where(eq(graphNodes.id, nodeId))
          .returning(),
      "updateGraphNode"
    )

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

    // Verify node exists before deleting
    const [existing] = await executeQuery(
      (db) =>
        db
          .select({ id: graphNodes.id })
          .from(graphNodes)
          .where(eq(graphNodes.id, nodeId))
          .limit(1),
      "deleteGraphNode:check"
    )

    if (!existing) {
      throw ErrorFactories.dbRecordNotFound("graph_nodes", nodeId)
    }

    // Delete node — edges cascade automatically via onDelete: "cascade"
    await executeQuery(
      (db) => db.delete(graphNodes).where(eq(graphNodes.id, nodeId)),
      "deleteGraphNode"
    )

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

    const conditions: SQL[] = []

    if (filters?.edgeType) {
      conditions.push(eq(graphEdges.edgeType, filters.edgeType))
    }
    if (filters?.sourceNodeId) {
      conditions.push(eq(graphEdges.sourceNodeId, filters.sourceNodeId))
    }
    if (filters?.targetNodeId) {
      conditions.push(eq(graphEdges.targetNodeId, filters.targetNodeId))
    }

    const edges = await executeQuery(
      (db) => {
        const query = db.select().from(graphEdges)
        if (conditions.length > 0) {
          return query.where(and(...conditions)).orderBy(desc(graphEdges.createdAt))
        }
        return query.orderBy(desc(graphEdges.createdAt))
      },
      "getGraphEdges"
    )

    timer({ status: "success" })
    log.info("Graph edges retrieved", { count: edges.length })
    return createSuccess(edges, `Retrieved ${edges.length} edges`)
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
  input: CreateGraphEdgeInput
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

    const [newEdge] = await executeQuery(
      (db) =>
        db
          .insert(graphEdges)
          .values({
            sourceNodeId: input.sourceNodeId,
            targetNodeId: input.targetNodeId,
            edgeType: input.edgeType.trim(),
            metadata: input.metadata ?? {},
            createdBy: currentUser.user.id,
          })
          .returning(),
      "createGraphEdge"
    )

    timer({ status: "success" })
    log.info("Graph edge created", { edgeId: newEdge.id })
    return createSuccess(newEdge, "Edge created successfully")
  } catch (error) {
    timer({ status: "error" })
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

    const [existing] = await executeQuery(
      (db) =>
        db
          .select({ id: graphEdges.id })
          .from(graphEdges)
          .where(eq(graphEdges.id, edgeId))
          .limit(1),
      "deleteGraphEdge:check"
    )

    if (!existing) {
      throw ErrorFactories.dbRecordNotFound("graph_edges", edgeId)
    }

    await executeQuery(
      (db) => db.delete(graphEdges).where(eq(graphEdges.id, edgeId)),
      "deleteGraphEdge"
    )

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

    // Get outgoing edges (this node is source)
    const outgoingEdges = await executeQuery(
      (db) =>
        db
          .select()
          .from(graphEdges)
          .where(eq(graphEdges.sourceNodeId, nodeId)),
      "getNodeConnections:outgoing"
    )

    // Get incoming edges (this node is target)
    const incomingEdges = await executeQuery(
      (db) =>
        db
          .select()
          .from(graphEdges)
          .where(eq(graphEdges.targetNodeId, nodeId)),
      "getNodeConnections:incoming"
    )

    // Collect unique connected node IDs
    const connectedNodeIds = new Set<string>()
    for (const edge of outgoingEdges) {
      connectedNodeIds.add(edge.targetNodeId)
    }
    for (const edge of incomingEdges) {
      connectedNodeIds.add(edge.sourceNodeId)
    }

    // Fetch connected node details
    const nodeMap = new Map<
      string,
      { id: string; name: string; nodeType: string; nodeClass: string }
    >()

    if (connectedNodeIds.size > 0) {
      const nodeIds = Array.from(connectedNodeIds)
      const connectedNodes = await executeQuery(
        (db) =>
          db
            .select({
              id: graphNodes.id,
              name: graphNodes.name,
              nodeType: graphNodes.nodeType,
              nodeClass: graphNodes.nodeClass,
            })
            .from(graphNodes)
            .where(inArray(graphNodes.id, nodeIds)),
        "getNodeConnections:nodes"
      )

      for (const node of connectedNodes) {
        nodeMap.set(node.id, node)
      }
    }

    // Build connections list
    const connections: NodeConnection[] = []

    for (const edge of outgoingEdges) {
      const connectedNode = nodeMap.get(edge.targetNodeId)
      if (connectedNode) {
        connections.push({
          edge,
          connectedNode,
          direction: "outgoing",
        })
      }
    }

    for (const edge of incomingEdges) {
      const connectedNode = nodeMap.get(edge.sourceNodeId)
      if (connectedNode) {
        connections.push({
          edge,
          connectedNode,
          direction: "incoming",
        })
      }
    }

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
