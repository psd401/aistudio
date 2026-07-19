/**
 * Shared type definitions for Decision Capture tools and UI.
 *
 * Used by both:
 * - lib/tools/decision-capture-tools.ts (tool implementations)
 * - nexus/decision-capture/_components/tools/decision-tools-ui.tsx (UI renderers)
 *
 * Part of Epic #675 (Context Graph Decision Capture Layer) - Issue #681
 */

export interface SearchGraphNodesArgs {
  query: string
  nodeType?: string
  limit?: number
}

export interface SearchGraphNodesResult {
  nodes: Array<{
    id: string
    name: string
    nodeType: string
    nodeClass: string
    description: string | null
  }>
  total: number
}

export interface ProposedNode {
  tempId: string
  name: string
  nodeType: string
  description: string | null
  existingNodeId?: string
  /**
   * Marks the primary decision — the one actually adopted. Required when a
   * proposal contains more than one "decision"-typed node (rejected
   * alternatives also use nodeType "decision").
   */
  isPrimary?: boolean
}

export interface ProposedEdge {
  sourceTempId: string
  targetTempId: string
  edgeType: string
}

export interface ProposeDecisionArgs {
  nodes: ProposedNode[]
  edges: ProposedEdge[]
  summary: string
}

export interface ProposeDecisionResult {
  summary: string
  nodes: ProposedNode[]
  edges: ProposedEdge[]
  completeness: {
    complete: boolean
    missing: string[]
  }
}

export interface CommitDecisionArgs {
  nodes: ProposedNode[]
  edges: ProposedEdge[]
  summary: string
}

/**
 * Discriminated on `success` so consumers get static guarantees: completeness
 * fields exist exactly when the commit succeeded, `error` exactly when it
 * failed.
 */
export type CommitDecisionResult =
  | {
      success: true
      committedNodeIds: string[]
      committedEdgeIds: string[]
      /** Rule-based completeness score (0-100) recomputed over the committed subgraph. */
      completenessScore: number
      /** Always "rule-based" for the committed subgraph (authoritative). */
      completenessMethod: "rule-based"
      /** Completeness warnings (missing decision elements). */
      warnings: string[]
    }
  | {
      success: false
      committedNodeIds: string[]
      committedEdgeIds: string[]
      /** Friendly, user-facing error message (never a raw DB string). */
      error: string
    }
