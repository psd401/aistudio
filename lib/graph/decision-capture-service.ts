/**
 * Decision Capture Service
 *
 * Shared service for creating structured decision subgraphs. This is the SINGLE
 * write path for all three decision-capture channels (Issue #1251):
 *   - REST  `POST /api/v1/graph/decisions`  -> captureStructuredDecision()
 *   - MCP   `capture_decision` tool handler  -> captureStructuredDecision()
 *   - Chat  `commit_decision` AI-SDK tool    -> commitDecisionSubgraph()
 *
 * The conversational channel previously ran its own, less-hardened inline
 * transaction; it now shares persistDecisionSubgraph() so every channel inherits
 * the same write-time vocabulary enforcement, self-reference / duplicate-edge
 * guards, typed friendly errors, and existing-node reuse.
 *
 * Originally extracted from route.ts as part of Issue #708 to achieve
 * MCP <-> REST API parity for decision capture.
 */

import { z } from "zod"
import { inArray } from "drizzle-orm"
import {
  translatePayloadToGraph,
  computeLlmScore,
  type DecisionApiPayload,
} from "@/lib/graph/decision-api-translator"
import {
  DECISION_NODE_TYPES,
  DECISION_EDGE_TYPES,
  isDecisionNodeType,
  isDecisionEdgeType,
  scoreDecisionSubgraph,
} from "@/lib/graph/decision-framework"
import { ErrorFactories } from "@/lib/error-utils"
import { isValidationError } from "@/types/error-types"
import { executeTransaction } from "@/lib/db/drizzle-client"
import { graphNodes, graphEdges } from "@/lib/db/schema"
import { createLogger, sanitizeForLogging } from "@/lib/logger"
import { graphMetadataSchema } from "@/lib/validations/api-schemas"

// ============================================
// Validation Schema
// ============================================

export const createDecisionSchema = z.object({
  decision: z.string().trim().min(1, "Decision text is required").max(2000),
  decidedBy: z.string().trim().min(1, "decidedBy is required").max(500),
  reasoning: z.string().trim().max(5000).optional(),
  evidence: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  constraints: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  conditions: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  alternatives_considered: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  // Deduplicate relatedTo at the schema layer so identical UUIDs cannot produce
  // duplicate CONTEXT edges that trip the uq_edge_source_target_type constraint
  // (Issue #1251). Lowercased first because Postgres compares uuids
  // case-insensitively, so "ABC..." and "abc..." are the same node.
  // max(50) is enforced against the raw input before dedup.
  relatedTo: z
    .array(z.string().uuid("Each relatedTo must be a valid UUID"))
    .max(50)
    .optional()
    .transform((arr) => (arr ? Array.from(new Set(arr.map((id) => id.toLowerCase()))) : arr)),
  agentId: z.string().trim().max(200).optional(),
  metadata: graphMetadataSchema.optional(),
})

export type DecisionPayload = z.infer<typeof createDecisionSchema>

// ============================================
// Result Types
// ============================================

export interface DecisionCaptureResult {
  decisionNodeId: string
  nodesCreated: number
  edgesCreated: number
  completenessScore: number
  completenessMethod: "rule-based" | "llm-enhanced"
  warnings: string[]
}

/** Result of the conversational commit_decision path. */
export interface CommitSubgraphResult {
  decisionNodeId: string | null
  committedNodeIds: string[]
  committedEdgeIds: string[]
  completenessScore: number
  completenessMethod: "rule-based"
  warnings: string[]
}

interface PersistResult {
  /** Real id of the primary decision node, or null when no primary was designated. */
  decisionNodeId: string | null
  committedNodeIds: string[]
  committedEdgeIds: string[]
}

/** Persisted completeness snapshot stored on the primary decision node. */
interface PersistedCompleteness {
  score: number
  method: "rule-based"
  warnings: string[]
}

// ============================================
// Shared Subgraph Input Shapes
// ============================================

/**
 * A node handed to the shared persist path. Both the translated REST/MCP nodes
 * and the LLM-proposed chat nodes normalize to this shape. When existingNodeId
 * is set the node is reused (verified) instead of inserted.
 */
interface SubgraphNodeInput {
  tempId: string
  name: string
  nodeType: string
  description?: string | null
  metadata?: Record<string, unknown>
  existingNodeId?: string
}

/** An edge referencing nodes by their tempId. */
interface SubgraphEdgeInput {
  sourceTempId: string
  targetTempId: string
  edgeType: string
}

interface PersistOptions {
  source: string
  userId: number
  requestId: string
  /** Existing node UUIDs to link to the decision via CONTEXT edges (REST path). */
  relatedTo?: string[]
  /** tempId of the primary decision node — receives userMetadata + completeness. */
  primaryDecisionTempId?: string
  /** Caller metadata merged onto the primary decision node only. */
  userMetadata?: Record<string, unknown>
  /** Completeness snapshot persisted into the primary decision node metadata. */
  completeness?: PersistedCompleteness
}

// ============================================
// Vocabulary Enforcement
// ============================================

/**
 * Reject any node_type / edge_type outside the closed decision vocabulary
 * (decision-framework.ts) BEFORE writing. Enforced at the shared persist layer
 * so all three channels inherit it (Issue #1251). Schema drift from LLM
 * extraction is the top real-world failure mode; a write-time allow-list is the
 * standard mitigation. Throws a typed ValidationError (400 / isError text).
 */
function assertDecisionVocabulary(
  nodes: Array<{ nodeType: string }>,
  edges: Array<{ edgeType: string }>
): void {
  const badNodeTypes = new Set<string>()
  const badEdgeTypes = new Set<string>()

  for (const node of nodes) {
    if (!isDecisionNodeType(node.nodeType.trim())) badNodeTypes.add(node.nodeType)
  }
  for (const edge of edges) {
    if (!isDecisionEdgeType(edge.edgeType.trim())) badEdgeTypes.add(edge.edgeType)
  }

  if (badNodeTypes.size === 0 && badEdgeTypes.size === 0) return

  const fields: Array<{ field: string; message: string }> = []
  for (const type of badNodeTypes) {
    fields.push({
      field: "nodeType",
      message: `Unknown node type "${type}". Allowed: ${DECISION_NODE_TYPES.join(", ")}`,
    })
  }
  for (const type of badEdgeTypes) {
    fields.push({
      field: "edgeType",
      message: `Unknown edge type "${type}". Allowed: ${DECISION_EDGE_TYPES.join(", ")}`,
    })
  }
  throw ErrorFactories.validationFailed(fields)
}

// ============================================
// Shared Transaction Persist
// ============================================

/** Extract the Postgres error code, if the thrown value carries one. */
function toPgCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === "string" ? code : undefined
  }
  return undefined
}

/**
 * Persist a decision subgraph atomically. Shared by every capture channel.
 *
 * Enforces (Issue #1251):
 *  - closed node/edge vocabulary (write-time allow-list)
 *  - no self-referencing edges (pre-validated by tempId; DB chk_no_self_reference
 *    is a backstop mapped to a friendly error)
 *  - no duplicate edges within the payload (deduped by resolved source/target/type;
 *    a residual uq_edge_source_target_type / 23505 race maps to a friendly error)
 *  - existing-node reuse (existingNodeId verified inside the tx)
 * All violations surface as typed ValidationErrors, never raw Postgres strings.
 */
async function persistDecisionSubgraph(
  nodes: SubgraphNodeInput[],
  edges: SubgraphEdgeInput[],
  options: PersistOptions
): Promise<PersistResult> {
  const { source, userId, requestId } = options
  const log = createLogger({ requestId, operation: "persistDecisionSubgraph" })

  // 1. Enforce the closed vocabulary before opening a transaction.
  assertDecisionVocabulary(nodes, edges)

  // 2. Reject self-referencing edges by tempId up front (clear message).
  for (const edge of edges) {
    if (edge.sourceTempId === edge.targetTempId) {
      throw ErrorFactories.validationFailed([
        { field: "edges", message: "A node cannot connect to itself" },
      ])
    }
  }

  let decisionNodeId: string | null = null
  const committedNodeIds: string[] = []
  const committedEdgeIds: string[] = []

  await executeTransaction(async (tx) => {
    const tempIdToRealId = new Map<string, string>()

    // 3. Validate relatedTo references exist (atomic with the writes).
    if (options.relatedTo && options.relatedTo.length > 0) {
      const existingNodes = await tx
        .select({ id: graphNodes.id })
        .from(graphNodes)
        .where(inArray(graphNodes.id, options.relatedTo))
      const foundIds = new Set(existingNodes.map((n) => n.id))
      const missingIds = options.relatedTo.filter((id) => !foundIds.has(id))
      if (missingIds.length > 0) {
        throw ErrorFactories.validationFailed([
          {
            field: "relatedTo",
            message: `Referenced nodes do not exist: ${missingIds.join(", ")}`,
          },
        ])
      }
    }

    // 4a. Verify reused nodes (existingNodeId) in one batched SELECT, checking
    // both existence and that the DB row's actual nodeType matches the caller's
    // declared nodeType — otherwise a mistyped reuse could fake completeness
    // (e.g. an "evidence" node declared as "person").
    const isPrimaryNode = (node: SubgraphNodeInput): boolean =>
      options.primaryDecisionTempId !== undefined &&
      node.tempId === options.primaryDecisionTempId

    const reusedNodes = nodes.filter((n) => n.existingNodeId)
    if (reusedNodes.length > 0) {
      const reusedIds = Array.from(new Set(reusedNodes.map((n) => n.existingNodeId as string)))
      const existingRows = await tx
        .select({ id: graphNodes.id, nodeType: graphNodes.nodeType })
        .from(graphNodes)
        .where(inArray(graphNodes.id, reusedIds))
      const typeById = new Map(existingRows.map((row) => [row.id, row.nodeType]))

      for (const node of reusedNodes) {
        const existingNodeId = node.existingNodeId as string
        const existingType = typeById.get(existingNodeId)
        if (existingType === undefined) {
          throw ErrorFactories.validationFailed([
            { field: "nodes", message: `Referenced node does not exist: ${existingNodeId}` },
          ])
        }
        const declaredType = node.nodeType.trim()
        if (existingType !== declaredType) {
          throw ErrorFactories.validationFailed([
            {
              field: "nodes",
              message: `Node ${existingNodeId} is a "${existingType}" node, not "${declaredType}"`,
            },
          ])
        }
        tempIdToRealId.set(node.tempId, existingNodeId)
        if (isPrimaryNode(node)) decisionNodeId = existingNodeId
      }
    }

    // 4b. Insert new nodes in one batched statement. userMetadata is spread
    // FIRST so callers can annotate the primary node but can never overwrite
    // internal provenance keys (source/agentId in node.metadata) or the
    // completeness snapshot.
    const newNodes = nodes.filter((n) => !n.existingNodeId)
    if (newNodes.length > 0) {
      const values = newNodes.map((node) => {
        const isPrimary = isPrimaryNode(node)
        const nodeMetadata: Record<string, unknown> = {
          ...(isPrimary && options.userMetadata ? options.userMetadata : {}),
          ...(node.metadata ?? {}),
          ...(isPrimary && options.completeness ? { completeness: options.completeness } : {}),
        }
        return {
          name: node.name.trim(),
          nodeType: node.nodeType.trim(),
          nodeClass: "decision",
          description: node.description?.trim() || null,
          metadata: nodeMetadata,
          createdBy: userId,
        }
      })

      let insertedNodes: Array<{ id: string }>
      try {
        insertedNodes = await tx.insert(graphNodes).values(values).returning({ id: graphNodes.id })
      } catch (error: unknown) {
        // Map integrity-constraint violations (class 23) to typed errors so they
        // are neither retried by executeTransaction nor leaked raw. Other errors
        // (e.g. connection class 08) propagate so transient retry still works.
        if (toPgCode(error)?.startsWith("23")) {
          throw ErrorFactories.validationFailed([
            { field: "nodes", message: "A node value violates a database constraint" },
          ])
        }
        throw error
      }
      if (insertedNodes.length !== newNodes.length) {
        throw new Error(
          `Node insert returned ${insertedNodes.length} ids for ${newNodes.length} values`
        )
      }

      newNodes.forEach((node, i) => {
        tempIdToRealId.set(node.tempId, insertedNodes[i].id)
        committedNodeIds.push(insertedNodes[i].id)
        if (isPrimaryNode(node)) decisionNodeId = insertedNodes[i].id
      })
    }

    // 5. Resolve edges to real IDs, dropping resolved self-refs / duplicates.
    const seenEdges = new Set<string>()
    const resolvedEdgeValues: Array<{
      sourceNodeId: string
      targetNodeId: string
      edgeType: string
      metadata: { source: string }
      createdBy: number
    }> = []

    for (const edge of edges) {
      const sourceId = tempIdToRealId.get(edge.sourceTempId)
      const targetId = tempIdToRealId.get(edge.targetTempId)
      if (!sourceId || !targetId) {
        throw ErrorFactories.validationFailed([
          {
            field: "edges",
            message: `Edge references unknown node: source=${edge.sourceTempId}, target=${edge.targetTempId}`,
          },
        ])
      }
      // Re-check self-reference on RESOLVED ids: two distinct tempIds can map to
      // the same real node via existingNodeId. The DB chk_no_self_reference
      // constraint remains the backstop; this throws the same friendly error
      // without waiting for the insert to fail.
      if (sourceId === targetId) {
        throw ErrorFactories.validationFailed([
          { field: "edges", message: "A node cannot connect to itself" },
        ])
      }
      const edgeType = edge.edgeType.trim()
      const key = `${sourceId}|${targetId}|${edgeType}`
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      resolvedEdgeValues.push({
        sourceNodeId: sourceId,
        targetNodeId: targetId,
        edgeType,
        metadata: { source },
        createdBy: userId,
      })
    }

    // 6. CONTEXT edges for relatedTo (deduped; guard against self-ref).
    if (options.relatedTo && options.relatedTo.length > 0 && decisionNodeId) {
      for (const relatedNodeId of options.relatedTo) {
        if (relatedNodeId === decisionNodeId) continue
        const key = `${relatedNodeId}|${decisionNodeId}|CONTEXT`
        if (seenEdges.has(key)) continue
        seenEdges.add(key)
        resolvedEdgeValues.push({
          sourceNodeId: relatedNodeId,
          targetNodeId: decisionNodeId,
          edgeType: "CONTEXT",
          metadata: { source },
          createdBy: userId,
        })
      }
    }

    // 7. Batch insert edges; map DB constraint violations to friendly errors.
    if (resolvedEdgeValues.length > 0) {
      try {
        const insertedEdges = await tx
          .insert(graphEdges)
          .values(resolvedEdgeValues)
          .returning({ id: graphEdges.id })
        committedEdgeIds.push(...insertedEdges.map((e) => e.id))
      } catch (error: unknown) {
        const code = toPgCode(error)
        if (code === "23505") {
          throw ErrorFactories.validationFailed([
            { field: "edges", message: "An identical relationship already exists between these nodes" },
          ])
        }
        if (code === "23503") {
          throw ErrorFactories.validationFailed([
            { field: "edges", message: "A referenced node no longer exists" },
          ])
        }
        if (code === "23514") {
          throw ErrorFactories.validationFailed([
            { field: "edges", message: "A node cannot connect to itself" },
          ])
        }
        throw error
      }
    }

    log.info("Transaction committed", {
      nodesCreated: committedNodeIds.length,
      edgesCreated: committedEdgeIds.length,
    })
  }, "createDecisionSubgraph")

  return { decisionNodeId, committedNodeIds, committedEdgeIds }
}

// ============================================
// Public API — Structured (REST + MCP)
// ============================================

/**
 * Capture a structured decision subgraph (REST + MCP channels).
 *
 * Validates the payload, translates it to graph nodes/edges, persists atomically
 * via the shared path, and computes the completeness score (rule-based
 * authoritative; LLM advisory only).
 *
 * @throws ValidationError for missing relatedTo references, off-vocabulary types,
 *   self-referencing or duplicate edges — never a raw Postgres string.
 */
export async function captureStructuredDecision(
  payload: DecisionPayload,
  userId: number,
  requestId: string
): Promise<DecisionCaptureResult> {
  const log = createLogger({ requestId, operation: "captureStructuredDecision" })

  log.info("Decision capture started", {
    decision: sanitizeForLogging(payload.decision),
    decidedBy: sanitizeForLogging(payload.decidedBy),
    relatedToCount: payload.relatedTo?.length ?? 0,
    hasMetadata: !!payload.metadata,
    userId,
  })

  // 1. Translate payload to graph nodes + edges
  const source = payload.agentId ? "agent" : "api"
  const apiPayload: DecisionApiPayload = {
    decision: payload.decision,
    decidedBy: payload.decidedBy,
    reasoning: payload.reasoning,
    evidence: payload.evidence,
    constraints: payload.constraints,
    conditions: payload.conditions,
    alternatives_considered: payload.alternatives_considered,
    relatedTo: payload.relatedTo,
    agentId: payload.agentId,
  }
  const translated = translatePayloadToGraph(apiPayload, source)

  // 2. Persist through the shared path (validation happens atomically).
  // TranslatedNode/TranslatedEdge are structurally assignable to the persist
  // input shapes, so no remapping is needed.
  const result = await persistDecisionSubgraph(translated.nodes, translated.edges, {
    source,
    userId,
    requestId,
    relatedTo: payload.relatedTo,
    primaryDecisionTempId: translated.decisionTempId,
    userMetadata: payload.metadata,
  })

  // The translator always mints a fresh primary decision node, so a missing id
  // here is an internal invariant violation, not a validation failure.
  if (!result.decisionNodeId) {
    throw new Error("Decision node was not created by persistDecisionSubgraph")
  }

  // 3. Compute completeness score (rule-based authoritative; LLM advisory)
  const completeness = await computeLlmScore(apiPayload, translated.nodes, translated.edges, log)

  log.info("Decision capture completed", {
    decisionNodeId: result.decisionNodeId,
    nodesCreated: result.committedNodeIds.length,
    edgesCreated: result.committedEdgeIds.length,
    completenessScore: completeness.score,
    completenessMethod: completeness.method,
    userId,
  })

  return {
    decisionNodeId: result.decisionNodeId,
    nodesCreated: result.committedNodeIds.length,
    edgesCreated: result.committedEdgeIds.length,
    completenessScore: completeness.score,
    completenessMethod: completeness.method,
    warnings: completeness.warnings,
  }
}

// ============================================
// Public API — Conversational (chat commit_decision)
// ============================================

/** Node shape proposed by the conversational LLM (mirrors ProposedNode). */
export interface CommitDecisionNode {
  tempId: string
  name: string
  nodeType: string
  description?: string | null
  existingNodeId?: string
  /**
   * Marks the primary decision — the one actually adopted. Required when the
   * proposal contains more than one "decision"-typed node (rejected
   * alternatives also use nodeType "decision"), since array order is not a
   * reliable signal from an LLM.
   */
  isPrimary?: boolean
}

/** Edge shape proposed by the conversational LLM (mirrors ProposedEdge). */
export interface CommitDecisionEdge {
  sourceTempId: string
  targetTempId: string
  edgeType: string
}

export interface CommitDecisionInput {
  nodes: CommitDecisionNode[]
  edges: CommitDecisionEdge[]
  summary: string
}

/**
 * Commit an LLM-proposed decision subgraph (conversational channel).
 *
 * Routes through the same shared persist path as REST/MCP (Issue #1251), so it
 * inherits vocabulary enforcement, self-reference / duplicate-edge guards, typed
 * errors, and existing-node reuse. Recomputes the rule-based completeness score
 * over the committed subgraph, persists it on the primary decision node's
 * metadata, and returns it in the result.
 */
export async function commitDecisionSubgraph(
  input: CommitDecisionInput,
  userId: number,
  requestId: string
): Promise<CommitSubgraphResult> {
  const log = createLogger({ requestId, operation: "commitDecisionSubgraph" })

  const nodes: SubgraphNodeInput[] = input.nodes.map((n) => ({
    tempId: n.tempId,
    name: n.name,
    nodeType: n.nodeType,
    description: n.description ?? null,
    metadata: { source: "decision-capture", summary: input.summary.substring(0, 200) },
    existingNodeId: n.existingNodeId,
  }))
  const edges: SubgraphEdgeInput[] = input.edges.map((e) => ({
    sourceTempId: e.sourceTempId,
    targetTempId: e.targetTempId,
    edgeType: e.edgeType,
  }))

  // Recompute completeness over the committed subgraph (rule-based, authoritative).
  const completeness = scoreDecisionSubgraph(nodes, edges)

  // Primary decision node — receives the persisted completeness snapshot. With a
  // single "decision" node it is unambiguous; with several (rejected
  // alternatives are also typed "decision") the LLM must mark exactly one with
  // isPrimary, since array order is not a reliable signal. If the primary is
  // reused (existingNodeId) or absent, metadata persistence is skipped but the
  // score is still returned.
  const decisionNodes = input.nodes.filter((n) => n.nodeType.trim() === "decision")
  const flaggedPrimaries = input.nodes.filter((n) => n.isPrimary)
  if (flaggedPrimaries.length > 1) {
    throw ErrorFactories.validationFailed([
      { field: "nodes", message: "Only one node may set isPrimary: true" },
    ])
  }
  if (flaggedPrimaries.length === 1 && flaggedPrimaries[0].nodeType.trim() !== "decision") {
    throw ErrorFactories.validationFailed([
      { field: "nodes", message: 'isPrimary must be set on a "decision" node' },
    ])
  }
  const primary = flaggedPrimaries[0] ?? (decisionNodes.length === 1 ? decisionNodes[0] : undefined)
  if (!primary && decisionNodes.length > 1) {
    throw ErrorFactories.validationFailed([
      {
        field: "nodes",
        message:
          'Multiple "decision" nodes proposed — set isPrimary: true on the decision that was actually adopted',
      },
    ])
  }
  const persistCompleteness =
    primary && !primary.existingNodeId
      ? { score: completeness.score, method: "rule-based" as const, warnings: completeness.warnings }
      : undefined

  const result = await persistDecisionSubgraph(nodes, edges, {
    source: "decision-capture",
    userId,
    requestId,
    primaryDecisionTempId: primary?.tempId,
    completeness: persistCompleteness,
  })

  log.info("Conversational decision committed", {
    decisionNodeId: result.decisionNodeId,
    nodesCreated: result.committedNodeIds.length,
    edgesCreated: result.committedEdgeIds.length,
    completenessScore: completeness.score,
    userId,
  })

  return {
    decisionNodeId: result.decisionNodeId,
    committedNodeIds: result.committedNodeIds,
    committedEdgeIds: result.committedEdgeIds,
    completenessScore: completeness.score,
    completenessMethod: "rule-based",
    warnings: completeness.warnings,
  }
}

// ============================================
// Error Presentation
// ============================================

/**
 * Convert a decision-capture error into a single user-facing string. Typed
 * ValidationErrors surface their field messages (e.g. "A node cannot connect to
 * itself"); anything else — unmapped database errors, provider failures — gets a
 * generic message so internal details (connection strings, constraint/table
 * names) never reach a user. Callers must log the raw error separately for
 * diagnostics. Used by the REST 400 body, the chat tool result card, and the
 * MCP isError text.
 */
export function describeDecisionError(error: unknown): string {
  if (isValidationError(error)) {
    const fieldMessages = (error.fields ?? []).map((f) => f.message).filter(Boolean)
    if (fieldMessages.length > 0) return fieldMessages.join("; ")
    return error.message
  }
  return "Failed to capture decision. Please try again."
}
