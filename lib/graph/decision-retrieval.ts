/**
 * Decision Retrieval (Issue #1252)
 *
 * Two hybrid-retrieval reads over the context graph:
 *
 *  1. getDecisionPackage(nodeId) — a single self-contained "decision package":
 *     the decision plus its evidence / constraints / reasoning / persons /
 *     conditions / outcomes and its supersession chain, gathered with a
 *     depth-bounded, cycle-safe recursive CTE (graph expansion wins "what led to
 *     this decision"). Used by the REST package endpoint and MCP get_decision_graph.
 *
 *  2. semanticSearchNodes(q) — embedding-seed search that returns paraphrase
 *     matches, not just ILIKE hits (vector RAG wins single-hop detail). Throws on
 *     embedding failure so callers can fall back to lexical search.
 */

import { and, inArray, sql } from "drizzle-orm"
import { executeQuery } from "@/lib/db/drizzle-client"
import { graphNodes, graphEdges } from "@/lib/db/schema"
import { createLogger } from "@/lib/logger"
import { generateGraphEmbedding } from "./graph-embeddings"
import type { SelectGraphNode, SelectGraphEdge } from "@/lib/db/types"

// ============================================
// Config
// ============================================

/** Default graph-expansion radius from the seed decision. */
export const DEFAULT_PACKAGE_DEPTH = 2
/** Hard cap on expansion depth (guards the recursive CTE). */
export const MAX_PACKAGE_DEPTH = 3

const DEFAULT_SEMANTIC_LIMIT = 10
const MAX_SEMANTIC_LIMIT = 50
/** Minimum cosine similarity for a semantic hit (paraphrase-tolerant). */
const DEFAULT_SEMANTIC_THRESHOLD = 0.4

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ============================================
// Types
// ============================================

export interface PackageNode {
  id: string
  name: string
  nodeType: string
  nodeClass: string
  description: string | null
  status: string | null
  supersededAt: Date | null
  metadata: SelectGraphNode["metadata"]
  createdAt: Date | null
  /** Shortest hop distance from the seed decision (0 = the seed). */
  depth: number
}

export interface PackageEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
  edgeType: string
}

/** One link in the supersession chain: `supersededId` was superseded by `supersededById`. */
export interface SupersessionLink {
  supersededId: string
  supersededById: string
}

export interface DecisionPackage {
  /** The seed node the package was built around. */
  decision: PackageNode
  /** Every node reachable within the depth bound (including the seed). */
  nodes: PackageNode[]
  /** Every edge whose endpoints are both inside the package. */
  edges: PackageEdge[]
  /** Nodes grouped by role, for a self-contained view. */
  persons: PackageNode[]
  evidence: PackageNode[]
  constraints: PackageNode[]
  reasoning: PackageNode[]
  conditions: PackageNode[]
  outcomes: PackageNode[]
  policies: PackageNode[]
  /** SUPERSEDED_BY edges among the package, oldest→newest not guaranteed. */
  supersessionChain: SupersessionLink[]
  /** The depth bound actually used. */
  depth: number
}

export interface SemanticMatch {
  id: string
  name: string
  nodeType: string
  nodeClass: string
  description: string | null
  status: string | null
  similarity: number
}

export interface SemanticSearchOptions {
  limit?: number
  /** Restrict to a node type (e.g. "decision" for a decision search). */
  nodeType?: string
  /** Restrict to a node class. */
  nodeClass?: string
  /** Restrict to a decision lifecycle status (e.g. "accepted" for current decisions). */
  status?: string
  threshold?: number
}

// ============================================
// Decision package
// ============================================

function clampDepth(depth?: number): number {
  // Floor first: MCP passes raw numbers, and a fractional depth would silently
  // change the recursive CTE's `r.depth < maxDepth` semantics.
  const wholeDepth = depth === undefined ? Number.NaN : Math.floor(depth)
  if (!wholeDepth || wholeDepth < 1) return DEFAULT_PACKAGE_DEPTH
  return Math.min(wholeDepth, MAX_PACKAGE_DEPTH)
}

function toPackageNode(row: SelectGraphNode, depth: number): PackageNode {
  return {
    id: row.id,
    name: row.name,
    nodeType: row.nodeType,
    nodeClass: row.nodeClass,
    description: row.description ?? null,
    status: row.status ?? null,
    supersededAt: row.supersededAt ?? null,
    metadata: row.metadata,
    createdAt: row.createdAt ?? null,
    depth,
  }
}

/**
 * Build a decision package around `nodeId`. Returns null when the node does not
 * exist. Uses a recursive CTE that:
 *   - starts at the seed (depth 0),
 *   - expands over edges in BOTH directions,
 *   - stops at `maxDepth` hops (bounded), and
 *   - is cycle-safe: a node already on the current path is never revisited
 *     (`NOT nxt.id = ANY(r.path)`), so cycles in the graph cannot loop forever.
 */
export async function getDecisionPackage(
  nodeId: string,
  options: { maxDepth?: number } = {}
): Promise<DecisionPackage | null> {
  if (!UUID_REGEX.test(nodeId)) {
    return null
  }

  const maxDepth = clampDepth(options.maxDepth)
  const log = createLogger({ operation: "getDecisionPackage" })

  // 1. Collect reachable node ids + their shortest depth (cycle-safe CTE).
  const reachableRows = (await executeQuery(
    (db) =>
      db.execute(sql`
        WITH RECURSIVE reachable AS (
          SELECT n.id AS id, 0 AS depth, ARRAY[n.id] AS path
          FROM graph_nodes n
          WHERE n.id = ${nodeId}::uuid
          UNION ALL
          SELECT nxt.id AS id, r.depth + 1 AS depth, r.path || nxt.id AS path
          FROM reachable r
          JOIN graph_edges e
            ON (e.source_node_id = r.id OR e.target_node_id = r.id)
          JOIN graph_nodes nxt
            ON nxt.id = CASE
                 WHEN e.source_node_id = r.id THEN e.target_node_id
                 ELSE e.source_node_id
               END
          WHERE r.depth < ${maxDepth}
            AND NOT nxt.id = ANY(r.path)
        )
        SELECT id, MIN(depth) AS depth
        FROM reachable
        GROUP BY id
      `),
    "getDecisionPackage:reachable"
  )) as unknown as Array<{ id: string; depth: number }>

  if (reachableRows.length === 0) {
    // Seed itself was not found.
    return null
  }

  const depthById = new Map<string, number>()
  for (const row of reachableRows) {
    depthById.set(String(row.id), Number(row.depth))
  }
  const ids = [...depthById.keys()]

  // 2. Fetch full node rows + edges internal to the package.
  const [nodeRows, edgeRows] = await Promise.all([
    executeQuery(
      (db) => db.select().from(graphNodes).where(inArray(graphNodes.id, ids)),
      "getDecisionPackage:nodes"
    ),
    executeQuery(
      (db) =>
        db
          .select()
          .from(graphEdges)
          .where(
            and(
              inArray(graphEdges.sourceNodeId, ids),
              inArray(graphEdges.targetNodeId, ids)
            )
          ),
      "getDecisionPackage:edges"
    ),
  ])

  const seedRow = (nodeRows as SelectGraphNode[]).find((n) => n.id === nodeId)
  if (!seedRow) return null

  const packageNodes = (nodeRows as SelectGraphNode[]).map((row) =>
    toPackageNode(row, depthById.get(row.id) ?? 0)
  )

  const byType = (type: string) => packageNodes.filter((n) => n.nodeType === type)

  const packageEdges: PackageEdge[] = (edgeRows as SelectGraphEdge[]).map((e) => ({
    id: e.id,
    sourceNodeId: e.sourceNodeId,
    targetNodeId: e.targetNodeId,
    edgeType: e.edgeType,
  }))

  const supersessionChain: SupersessionLink[] = packageEdges
    .filter((e) => e.edgeType === "SUPERSEDED_BY")
    .map((e) => ({ supersededId: e.sourceNodeId, supersededById: e.targetNodeId }))

  log.info("Decision package assembled", {
    seedId: nodeId,
    depth: maxDepth,
    nodeCount: packageNodes.length,
    edgeCount: packageEdges.length,
    supersessionLinks: supersessionChain.length,
  })

  return {
    decision: toPackageNode(seedRow, 0),
    nodes: packageNodes,
    edges: packageEdges,
    persons: byType("person"),
    evidence: byType("evidence"),
    constraints: byType("constraint"),
    reasoning: byType("reasoning"),
    conditions: byType("condition"),
    outcomes: byType("outcome"),
    policies: byType("policy"),
    supersessionChain,
    depth: maxDepth,
  }
}

// ============================================
// Semantic search
// ============================================

/**
 * Embedding-based node search. Embeds `q` via the direct-Bedrock helper and
 * returns paraphrase matches ranked by cosine similarity (HNSW-backed).
 *
 * THROWS if embedding fails (Bedrock down, empty query) so the caller can fall
 * back to lexical ILIKE search — semantic search degrading to lexical is better
 * than a 500.
 */
export async function semanticSearchNodes(
  q: string,
  options: SemanticSearchOptions = {}
): Promise<SemanticMatch[]> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEMANTIC_LIMIT, 1), MAX_SEMANTIC_LIMIT)
  const threshold = options.threshold ?? DEFAULT_SEMANTIC_THRESHOLD
  const { nodeType, nodeClass, status } = options

  const embedding = await generateGraphEmbedding(q)
  const vectorLiteral = `[${embedding.join(",")}]`

  const rows = (await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT
          id,
          name,
          node_type,
          node_class,
          description,
          status,
          1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
        FROM graph_nodes
        WHERE embedding IS NOT NULL
          ${nodeType ? sql`AND node_type = ${nodeType}` : sql``}
          ${nodeClass ? sql`AND node_class = ${nodeClass}` : sql``}
          ${status ? sql`AND status = ${status}` : sql``}
          AND 1 - (embedding <=> ${vectorLiteral}::vector) >= ${threshold}
        ORDER BY embedding <=> ${vectorLiteral}::vector
        LIMIT ${limit}
      `),
    "semanticSearchNodes"
  )) as unknown as Array<Record<string, unknown>>

  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ""),
    nodeType: String(row.node_type ?? ""),
    nodeClass: String(row.node_class ?? ""),
    description: row.description == null ? null : String(row.description),
    status: row.status == null ? null : String(row.status),
    similarity: Number(row.similarity) || 0,
  }))
}
