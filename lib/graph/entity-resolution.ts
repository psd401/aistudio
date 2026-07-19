/**
 * Entity Resolution (Issue #1252)
 *
 * Deduplicates graph nodes at capture time using embedding similarity, so
 * "Technology Committee" submitted twice does not create two `person` nodes.
 *
 * Policy — threshold-banded, deterministic, non-interactive, NEVER destructive:
 *   - similarity >= ER_AUTO_REUSE_THRESHOLD (0.90) → auto-reuse the existing node
 *     (set existingNodeId), record `metadata.dedup`, and emit a warning.
 *   - ER_CANDIDATE_THRESHOLD (0.75) <= similarity < 0.90 → create a NEW node but
 *     surface the candidate matches in warnings (so a human / the chat LLM can pick
 *     an existingNodeId next time).
 *   - similarity < 0.75 → create a new node silently.
 *
 * Only person/evidence/policy nodes are resolved (the entity-like types).
 * Decision nodes are embedded too (for semantic search) but never auto-merged.
 * No destructive merges ever happen here — reuse points a mention at an existing
 * node; the `SAME_AS` edge type exists for later human canonicalization.
 *
 * Graceful degradation: if the Bedrock embedding call fails, resolution is
 * skipped and the nodes are created WITHOUT dedup (a warning is returned). A
 * decision is never lost to this helper — see the DoD.
 */

import { sql } from "drizzle-orm"
import { executeQuery } from "@/lib/db/drizzle-client"
import { createLogger } from "@/lib/logger"
import { generateGraphEmbedding, GRAPH_EMBEDDING_DIMENSIONS } from "./graph-embeddings"

// ============================================
// Tunable thresholds (named constants)
// ============================================

/** >= this cosine similarity auto-reuses the existing node. */
export const ER_AUTO_REUSE_THRESHOLD = 0.9
/** >= this (and < auto-reuse) surfaces candidate matches without reusing. */
export const ER_CANDIDATE_THRESHOLD = 0.75

/** Node types that participate in dedup (entity-like). */
export const ER_NODE_TYPES: ReadonlySet<string> = new Set([
  "person",
  "evidence",
  "policy",
])

/** Node types embedded at capture (dedup set + decisions for semantic search). */
export const EMBEDDABLE_NODE_TYPES: ReadonlySet<string> = new Set([
  "decision",
  "person",
  "evidence",
  "policy",
])

/** How many candidate matches to surface in the mid-band warning. */
const MAX_CANDIDATES = 3

/** How many nearest neighbours to fetch per candidate. */
const NEIGHBOUR_LIMIT = 5

// ============================================
// Types
// ============================================

/**
 * The mutable node shape entity resolution operates on. `SubgraphNodeInput` in
 * the capture service is structurally assignable to this (Issue #1252), so no
 * remapping is needed and the concrete type is preserved via the generic below.
 */
export interface ResolvableNode {
  tempId: string
  name: string
  nodeType: string
  description?: string | null
  metadata?: Record<string, unknown>
  existingNodeId?: string
  /** Populated for new, embeddable nodes so the persist path can write it. */
  embedding?: number[]
}

export interface SimilarNodeMatch {
  id: string
  name: string
  similarity: number
}

export interface EntityResolutionResult {
  /** Human-readable warnings (auto-reuse notices + candidate suggestions). */
  warnings: string[]
  /** True when at least one embedding call failed and dedup was skipped. */
  degraded: boolean
  /** Count of nodes auto-reused (existingNodeId set by this pass). */
  reused: number
}

// ============================================
// Similarity search
// ============================================

/** Format a JS number[] as a pgvector literal: `[1,2,3]`. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`
}

/**
 * Find the nearest existing same-type nodes to an embedding using the pgvector
 * cosine operator (`<=>`). Ordered by ascending distance (descending similarity)
 * and backed by the HNSW index (idx_graph_nodes_embedding_hnsw). Rows with a
 * NULL embedding are excluded. All values are bound parameters — no string
 * interpolation into SQL.
 */
export async function findSimilarNodes(
  embedding: number[],
  nodeType: string,
  options: { limit?: number } = {}
): Promise<SimilarNodeMatch[]> {
  const limit = options.limit ?? NEIGHBOUR_LIMIT
  const vectorLiteral = toVectorLiteral(embedding)

  const rows = await executeQuery(
    (db) =>
      db.execute(sql`
        SELECT
          id,
          name,
          1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
        FROM graph_nodes
        WHERE node_type = ${nodeType}
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vectorLiteral}::vector
        LIMIT ${limit}
      `),
    "findSimilarNodes"
  )

  const list = rows as unknown as Array<Record<string, unknown>>
  return list.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ""),
    similarity: Number(row.similarity) || 0,
  }))
}

// ============================================
// Resolution
// ============================================

function embeddingText(node: ResolvableNode): string {
  const desc = node.description?.trim()
  return desc ? `${node.name.trim()}\n${desc}` : node.name.trim()
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Resolve a batch of subgraph nodes against existing graph nodes, MUTATING each
 * node in place (embedding, existingNodeId, metadata.dedup) and returning the
 * warnings + degradation flag. Runs BEFORE the persist transaction — embedding
 * and similarity search are external/read-only I/O that must not be held inside
 * a write transaction.
 *
 * Never throws for an embedding failure: the whole pass degrades to "no dedup"
 * (each affected node is created as-is) so a capture is never lost. A genuinely
 * exceptional DB error from findSimilarNodes still degrades that node rather than
 * aborting the capture.
 */
export async function resolveEntities<T extends ResolvableNode>(
  nodes: T[],
  options: { requestId: string }
): Promise<EntityResolutionResult> {
  const log = createLogger({ requestId: options.requestId, operation: "resolveEntities" })
  const warnings: string[] = []
  let degraded = false
  let reused = 0

  // Only new, embeddable nodes are candidates. Reused nodes (existingNodeId
  // already set by the caller) are left untouched.
  const candidates = nodes.filter(
    (n) => !n.existingNodeId && EMBEDDABLE_NODE_TYPES.has(n.nodeType.trim())
  )
  if (candidates.length === 0) {
    return { warnings, degraded, reused }
  }

  for (const node of candidates) {
    let embedding: number[]
    try {
      embedding = await generateGraphEmbedding(embeddingText(node))
    } catch (error) {
      degraded = true
      log.warn("Embedding failed — entity resolution skipped for remaining nodes", {
        error: error instanceof Error ? error.message : String(error),
      })
      warnings.push(
        "Entity resolution unavailable (embedding service error) — nodes created without deduplication."
      )
      break
    }

    if (embedding.length !== GRAPH_EMBEDDING_DIMENSIONS) {
      // Defensive: generateGraphEmbedding already validates this.
      continue
    }

    // Store the embedding so the persist path writes it (enables semantic search
    // + future dedup). Overwritten below if this node is auto-reused.
    node.embedding = embedding

    // Only the entity-like types are deduplicated.
    if (!ER_NODE_TYPES.has(node.nodeType.trim())) continue

    let matches: SimilarNodeMatch[]
    try {
      matches = await findSimilarNodes(embedding, node.nodeType.trim())
    } catch (error) {
      // A search failure must not lose the capture — create the node without dedup.
      log.warn("Similarity search failed — node created without dedup", {
        nodeType: node.nodeType,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    const top = matches[0]
    if (!top) continue

    if (top.similarity >= ER_AUTO_REUSE_THRESHOLD) {
      // Auto-reuse: point this mention at the existing node. Non-destructive.
      node.existingNodeId = top.id
      node.embedding = undefined // reusing an existing node → no new embedding write
      node.metadata = {
        ...(node.metadata ?? {}),
        dedup: { matchedNodeId: top.id, similarity: round3(top.similarity) },
      }
      reused += 1
      warnings.push(
        `Reused existing ${node.nodeType} "${top.name}" for "${node.name}" (similarity ${round3(
          top.similarity
        )}).`
      )
    } else if (top.similarity >= ER_CANDIDATE_THRESHOLD) {
      // Mid-band: keep new, surface candidates so a human/LLM can canonicalize.
      const candidateList = matches
        .filter((m) => m.similarity >= ER_CANDIDATE_THRESHOLD)
        .slice(0, MAX_CANDIDATES)
        .map((m) => `"${m.name}" (${round3(m.similarity)}, ${m.id})`)
        .join("; ")
      warnings.push(
        `Possible duplicate ${node.nodeType} "${node.name}" — similar existing nodes: ${candidateList}. Set existingNodeId to reuse one.`
      )
    }
    // similarity < ER_CANDIDATE_THRESHOLD → create silently.
  }

  return { warnings, degraded, reused }
}
