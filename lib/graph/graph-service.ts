/**
 * Graph Service Layer
 * Pure database functions for context graph operations.
 * No auth, no ActionState — used by both server actions and API routes.
 * Part of Epic #674 (External API Platform) - Issue #679
 */

import { executeQuery } from "@/lib/db/drizzle-client"
import { createLogger } from "@/lib/logger"
import { eq, or, ilike, and, desc, lt, inArray, type SQL } from "drizzle-orm"
import { graphNodes, graphEdges } from "@/lib/db/schema"
import type {
  SelectGraphNode,
  SelectGraphEdge,
  GraphNodeMetadata,
  GraphEdgeMetadata,
} from "@/lib/db/types"

// ============================================
// Input / Output Types
// ============================================

export interface GraphNodeFilters {
  nodeType?: string
  nodeClass?: string
  search?: string
}

export interface GraphEdgeFilters {
  edgeType?: string
  sourceNodeId?: string
  targetNodeId?: string
}

export interface PaginationParams {
  limit?: number
  cursor?: string
}

export interface PaginatedResult<T> {
  items: T[]
  nextCursor: string | null
  total?: number
}

export interface CreateNodeInput {
  name: string
  nodeType: string
  nodeClass: string
  description?: string | null
  metadata?: GraphNodeMetadata
}

export interface UpdateNodeInput {
  name?: string
  nodeType?: string
  nodeClass?: string
  description?: string | null
  metadata?: GraphNodeMetadata
}

export interface CreateEdgeInput {
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
// Cursor Helpers
// ============================================

interface CursorPayload {
  createdAt: string
  id: string
}

function encodeCursor(createdAt: Date | string, id: string): string {
  const payload: CursorPayload = {
    createdAt: typeof createdAt === "string" ? createdAt : createdAt.toISOString(),
    id,
  }
  return Buffer.from(JSON.stringify(payload)).toString("base64url")
}

function decodeCursor(cursor: string): CursorPayload | null {
  const log = createLogger({ action: "decodeCursor" })

  try {
    const json = Buffer.from(cursor, "base64url").toString("utf-8")
    const parsed = JSON.parse(json) as CursorPayload
    if (!parsed.createdAt || !parsed.id) {
      log.warn("Invalid cursor payload", { cursorPrefix: cursor.substring(0, 20) })
      return null
    }
    return parsed
  } catch (error) {
    log.warn("Cursor decode failed", {
      error: error instanceof Error ? error.message : "unknown",
      cursorPrefix: cursor.substring(0, 20),
    })
    return null
  }
}

// ============================================
// Node Operations
// ============================================

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

function clampLimit(limit?: number): number {
  if (!limit || limit < 1) return DEFAULT_LIMIT
  return Math.min(limit, MAX_LIMIT)
}

export async function queryGraphNodes(
  filters?: GraphNodeFilters,
  pagination?: PaginationParams
): Promise<PaginatedResult<SelectGraphNode>> {
  const limit = clampLimit(pagination?.limit)
  const cursor = pagination?.cursor ? decodeCursor(pagination.cursor) : null

  const conditions: SQL[] = []

  if (filters?.nodeType) {
    conditions.push(eq(graphNodes.nodeType, filters.nodeType))
  }
  if (filters?.nodeClass) {
    conditions.push(eq(graphNodes.nodeClass, filters.nodeClass))
  }
  if (filters?.search) {
    // Escape ILIKE special characters: backslash first, then wildcards
    const sanitized = filters.search
      .replace(/\\/g, '\\\\')    // Escape backslashes first
      .replace(/[%_]/g, '\\$&')  // Then escape ILIKE wildcards
      .slice(0, 100)              // Limit length
      .trim()

    if (sanitized.length > 0) {
      conditions.push(
        or(
          ilike(graphNodes.name, `%${sanitized}%`),
          ilike(graphNodes.description, `%${sanitized}%`)
        )!
      )
    }
  }

  // Cursor condition: fetch rows older than cursor (descending order)
  if (cursor) {
    conditions.push(
      or(
        lt(graphNodes.createdAt, new Date(cursor.createdAt)),
        and(
          eq(graphNodes.createdAt, new Date(cursor.createdAt)),
          lt(graphNodes.id, cursor.id)
        )
      )!
    )
  }

  // Fetch limit + 1 to detect hasMore
  const rows = await executeQuery(
    (db) => {
      const query = db.select().from(graphNodes)
      const ordered = conditions.length > 0
        ? query.where(and(...conditions)).orderBy(desc(graphNodes.createdAt), desc(graphNodes.id))
        : query.orderBy(desc(graphNodes.createdAt), desc(graphNodes.id))
      return ordered.limit(limit + 1)
    },
    "queryGraphNodes"
  )

  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore && items.length > 0
    ? encodeCursor(items[items.length - 1].createdAt!, items[items.length - 1].id)
    : null

  return { items, nextCursor }
}

export async function queryGraphNode(
  nodeId: string
): Promise<SelectGraphNode | null> {
  const [node] = await executeQuery(
    (db) =>
      db
        .select()
        .from(graphNodes)
        .where(eq(graphNodes.id, nodeId))
        .limit(1),
    "queryGraphNode"
  )
  return node ?? null
}

export async function insertGraphNode(
  input: CreateNodeInput,
  createdBy: number
): Promise<SelectGraphNode> {
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
          createdBy,
        })
        .returning(),
    "insertGraphNode"
  )
  return newNode
}

export async function patchGraphNode(
  nodeId: string,
  input: UpdateNodeInput
): Promise<SelectGraphNode | null> {
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
    "patchGraphNode"
  )
  return updated ?? null
}

export async function removeGraphNode(
  nodeId: string
): Promise<boolean> {
  // Verify existence
  const [existing] = await executeQuery(
    (db) =>
      db
        .select({ id: graphNodes.id })
        .from(graphNodes)
        .where(eq(graphNodes.id, nodeId))
        .limit(1),
    "removeGraphNode:check"
  )

  if (!existing) return false

  await executeQuery(
    (db) => db.delete(graphNodes).where(eq(graphNodes.id, nodeId)),
    "removeGraphNode"
  )
  return true
}

// ============================================
// Edge Operations
// ============================================

export async function queryGraphEdges(
  filters?: GraphEdgeFilters,
  pagination?: PaginationParams
): Promise<PaginatedResult<SelectGraphEdge>> {
  const limit = clampLimit(pagination?.limit)
  const cursor = pagination?.cursor ? decodeCursor(pagination.cursor) : null

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

  if (cursor) {
    conditions.push(
      or(
        lt(graphEdges.createdAt, new Date(cursor.createdAt)),
        and(
          eq(graphEdges.createdAt, new Date(cursor.createdAt)),
          lt(graphEdges.id, cursor.id)
        )
      )!
    )
  }

  const rows = await executeQuery(
    (db) => {
      const query = db.select().from(graphEdges)
      const ordered = conditions.length > 0
        ? query.where(and(...conditions)).orderBy(desc(graphEdges.createdAt), desc(graphEdges.id))
        : query.orderBy(desc(graphEdges.createdAt), desc(graphEdges.id))
      return ordered.limit(limit + 1)
    },
    "queryGraphEdges"
  )

  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore && items.length > 0
    ? encodeCursor(items[items.length - 1].createdAt!, items[items.length - 1].id)
    : null

  return { items, nextCursor }
}

export async function insertGraphEdge(
  input: CreateEdgeInput,
  createdBy: number
): Promise<SelectGraphEdge> {
  // Validate both nodes exist
  const nodes = await executeQuery(
    (db) =>
      db
        .select({ id: graphNodes.id })
        .from(graphNodes)
        .where(inArray(graphNodes.id, [input.sourceNodeId, input.targetNodeId])),
    "insertGraphEdge:validateNodes"
  )

  if (nodes.length !== 2) {
    const foundIds = new Set(nodes.map((n) => n.id))
    const missingId = !foundIds.has(input.sourceNodeId)
      ? input.sourceNodeId
      : input.targetNodeId
    throw new GraphServiceError(`Node not found: ${missingId}`, "NODE_NOT_FOUND")
  }

  // Check for duplicate edge
  const [existingEdge] = await executeQuery(
    (db) =>
      db
        .select({ id: graphEdges.id })
        .from(graphEdges)
        .where(
          and(
            eq(graphEdges.sourceNodeId, input.sourceNodeId),
            eq(graphEdges.targetNodeId, input.targetNodeId),
            eq(graphEdges.edgeType, input.edgeType.trim())
          )
        )
        .limit(1),
    "insertGraphEdge:checkDuplicate"
  )

  if (existingEdge) {
    throw new GraphServiceError(
      `Edge of type '${input.edgeType}' already exists between these nodes`,
      "DUPLICATE_EDGE"
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
          createdBy,
        })
        .returning(),
    "insertGraphEdge"
  )
  return newEdge
}

export async function removeGraphEdge(
  edgeId: string
): Promise<boolean> {
  const [existing] = await executeQuery(
    (db) =>
      db
        .select({ id: graphEdges.id })
        .from(graphEdges)
        .where(eq(graphEdges.id, edgeId))
        .limit(1),
    "removeGraphEdge:check"
  )

  if (!existing) return false

  await executeQuery(
    (db) => db.delete(graphEdges).where(eq(graphEdges.id, edgeId)),
    "removeGraphEdge"
  )
  return true
}

// ============================================
// Query Operations
// ============================================

export async function queryNodeConnections(
  nodeId: string
): Promise<NodeConnection[]> {
  // Fetch outgoing and incoming edges in parallel for better performance
  const [outgoingEdges, incomingEdges] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select()
          .from(graphEdges)
          .where(eq(graphEdges.sourceNodeId, nodeId)),
      "queryNodeConnections:outgoing"
    ),
    executeQuery(
      (db) =>
        db
          .select()
          .from(graphEdges)
          .where(eq(graphEdges.targetNodeId, nodeId)),
      "queryNodeConnections:incoming"
    ),
  ])

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
      "queryNodeConnections:nodes"
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
      connections.push({ edge, connectedNode, direction: "outgoing" })
    }
  }

  for (const edge of incomingEdges) {
    const connectedNode = nodeMap.get(edge.sourceNodeId)
    if (connectedNode) {
      connections.push({ edge, connectedNode, direction: "incoming" })
    }
  }

  return connections
}

// ============================================
// Service Error
// ============================================

export class GraphServiceError extends Error {
  constructor(
    message: string,
    public readonly code: "NODE_NOT_FOUND" | "EDGE_NOT_FOUND" | "DUPLICATE_EDGE" | "SELF_REFERENCE"
  ) {
    super(message)
    this.name = "GraphServiceError"
  }
}
