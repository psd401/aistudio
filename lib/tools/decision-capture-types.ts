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

export interface CommitDecisionResult {
  success: boolean
  committedNodeIds: string[]
  committedEdgeIds: string[]
  error?: string
}
