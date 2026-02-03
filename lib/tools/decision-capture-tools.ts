/**
 * Decision Capture Tools for AI SDK
 *
 * Four tools that enable LLMs to extract, validate, and commit decisions
 * from meeting transcripts into the context graph.
 *
 * Part of Epic #675 (Context Graph Decision Capture Layer) - Issue #681
 */

import type { Tool } from 'ai'
import { jsonSchema } from 'ai'
import { createLogger } from '@/lib/logger'
import {
  queryGraphNodes,
} from '@/lib/graph/graph-service'
import {
  validateDecisionCompleteness,
  isDecisionNodeType,
  isDecisionEdgeType,
  type DecisionSubgraphNode,
  type DecisionSubgraphEdge,
} from '@/lib/graph/decision-framework'
import { executeTransaction } from '@/lib/db/drizzle-client'
import { graphNodes, graphEdges } from '@/lib/db/schema'
import { inArray } from 'drizzle-orm'

const log = createLogger({ module: 'decision-capture-tools' })

// ============================================
// Tool Argument & Result Types
// ============================================

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

export interface ValidateCompletenessArgs {
  nodes: Array<{ id: string; nodeType: string }>
  edges: Array<{ sourceNodeId: string; targetNodeId: string; edgeType: string }>
}

export interface ValidateCompletenessResult {
  complete: boolean
  missing: string[]
}

// ============================================
// Tool Implementations
// ============================================

function createSearchGraphNodesTool(): Tool<SearchGraphNodesArgs, SearchGraphNodesResult> {
  return {
    description: `Search existing graph nodes by name or description. Use this BEFORE proposing new nodes to avoid creating duplicates. Returns matching nodes from the context graph.`,
    inputSchema: jsonSchema<SearchGraphNodesArgs>({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to match against node names and descriptions',
          minLength: 1,
          maxLength: 200,
        },
        nodeType: {
          type: 'string',
          description: 'Optional filter by node type (e.g., "decision", "person", "evidence")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10, max: 50)',
        },
      },
      required: ['query'],
    }),
    execute: async (args: SearchGraphNodesArgs): Promise<SearchGraphNodesResult> => {
      log.info('Searching graph nodes', { query: args.query, nodeType: args.nodeType })

      const result = await queryGraphNodes(
        {
          search: args.query,
          nodeType: args.nodeType,
        },
        { limit: Math.min(args.limit || 10, 50) }
      )

      return {
        nodes: result.items.map((node) => ({
          id: node.id,
          name: node.name,
          nodeType: node.nodeType,
          nodeClass: node.nodeClass,
          description: node.description,
        })),
        total: result.items.length,
      }
    },
  }
}

function createProposeDecisionTool(): Tool<ProposeDecisionArgs, ProposeDecisionResult> {
  return {
    description: `Format an extracted decision as a structured subgraph for display. This does NOT write to the database — it shows the user what will be committed and runs completeness validation. Each node needs a tempId (any unique string) so edges can reference them. Set existingNodeId on a node to link to an existing graph node instead of creating a new one. Only call commit_decision after the user confirms this proposal.`,
    inputSchema: jsonSchema<ProposeDecisionArgs>({
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'A concise summary of the decision being proposed',
        },
        nodes: {
          type: 'array',
          description: 'Proposed graph nodes for this decision',
          items: {
            type: 'object',
            properties: {
              tempId: { type: 'string', description: 'Temporary ID for edge references (e.g., "node-1")' },
              name: { type: 'string', description: 'Node name' },
              nodeType: { type: 'string', description: 'Node type (decision, evidence, constraint, reasoning, person, condition, request, policy, outcome)' },
              description: { type: 'string', description: 'Node description (nullable)' },
              existingNodeId: { type: 'string', description: 'If linking to an existing node, its UUID. Omit to create new.' },
            },
            required: ['tempId', 'name', 'nodeType'],
          },
        },
        edges: {
          type: 'array',
          description: 'Proposed edges connecting nodes by their tempIds',
          items: {
            type: 'object',
            properties: {
              sourceTempId: { type: 'string', description: 'Source node tempId' },
              targetTempId: { type: 'string', description: 'Target node tempId' },
              edgeType: { type: 'string', description: 'Edge type (INFORMED, LED_TO, CONSTRAINED, PROPOSED, APPROVED_BY, etc.)' },
            },
            required: ['sourceTempId', 'targetTempId', 'edgeType'],
          },
        },
      },
      required: ['summary', 'nodes', 'edges'],
    }),
    execute: async (args: ProposeDecisionArgs): Promise<ProposeDecisionResult> => {
      log.info('Proposing decision', {
        summary: args.summary.substring(0, 100),
        nodeCount: args.nodes.length,
        edgeCount: args.edges.length,
      })

      // Validate node types
      for (const node of args.nodes) {
        if (!isDecisionNodeType(node.nodeType)) {
          log.warn('Invalid node type in proposal', { nodeType: node.nodeType, tempId: node.tempId })
        }
      }

      // Validate edge types
      for (const edge of args.edges) {
        if (!isDecisionEdgeType(edge.edgeType)) {
          log.warn('Invalid edge type in proposal', { edgeType: edge.edgeType })
        }
      }

      // Build subgraph for completeness validation
      const subgraphNodes: DecisionSubgraphNode[] = args.nodes.map((n) => ({
        id: n.tempId,
        nodeType: n.nodeType,
      }))

      const subgraphEdges: DecisionSubgraphEdge[] = args.edges.map((e) => ({
        sourceNodeId: e.sourceTempId,
        targetNodeId: e.targetTempId,
        edgeType: e.edgeType,
      }))

      const completeness = validateDecisionCompleteness(subgraphNodes, subgraphEdges)

      return {
        summary: args.summary,
        nodes: args.nodes,
        edges: args.edges,
        completeness,
      }
    },
  }
}

function createCommitDecisionTool(userId: number): Tool<CommitDecisionArgs, CommitDecisionResult> {
  return {
    description: `Write confirmed decision nodes and edges to the context graph database. Only call this AFTER the user has reviewed and confirmed the proposal from propose_decision. This is a write operation.`,
    inputSchema: jsonSchema<CommitDecisionArgs>({
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Summary of the decision being committed',
        },
        nodes: {
          type: 'array',
          description: 'Nodes to commit (same format as propose_decision)',
          items: {
            type: 'object',
            properties: {
              tempId: { type: 'string' },
              name: { type: 'string' },
              nodeType: { type: 'string' },
              description: { type: 'string' },
              existingNodeId: { type: 'string' },
            },
            required: ['tempId', 'name', 'nodeType'],
          },
        },
        edges: {
          type: 'array',
          description: 'Edges to commit (same format as propose_decision)',
          items: {
            type: 'object',
            properties: {
              sourceTempId: { type: 'string' },
              targetTempId: { type: 'string' },
              edgeType: { type: 'string' },
            },
            required: ['sourceTempId', 'targetTempId', 'edgeType'],
          },
        },
      },
      required: ['summary', 'nodes', 'edges'],
    }),
    execute: async (args: CommitDecisionArgs): Promise<CommitDecisionResult> => {
      log.info('Committing decision to graph', {
        summary: args.summary.substring(0, 100),
        nodeCount: args.nodes.length,
        edgeCount: args.edges.length,
        userId,
      })

      const committedNodeIds: string[] = []
      const committedEdgeIds: string[] = []

      try {
        // Map tempId -> real UUID after insert
        const tempIdToRealId = new Map<string, string>()

        await executeTransaction(async (tx) => {
          // 1. Create or map nodes
          for (const node of args.nodes) {
            if (node.existingNodeId) {
              // Verify existing node exists
              const existing = await tx
                .select({ id: graphNodes.id })
                .from(graphNodes)
                .where(inArray(graphNodes.id, [node.existingNodeId]))
                .limit(1)

              if (existing.length === 0) {
                throw new Error(`Existing node not found: ${node.existingNodeId}`)
              }
              tempIdToRealId.set(node.tempId, node.existingNodeId)
            } else {
              const [newNode] = await tx
                .insert(graphNodes)
                .values({
                  name: node.name.trim(),
                  nodeType: node.nodeType.trim(),
                  nodeClass: 'decision',
                  description: node.description?.trim() || null,
                  metadata: { source: 'decision-capture', summary: args.summary.substring(0, 200) },
                  createdBy: userId,
                })
                .returning({ id: graphNodes.id })

              tempIdToRealId.set(node.tempId, newNode.id)
              committedNodeIds.push(newNode.id)
            }
          }

          // 2. Create edges
          for (const edge of args.edges) {
            const sourceId = tempIdToRealId.get(edge.sourceTempId)
            const targetId = tempIdToRealId.get(edge.targetTempId)

            if (!sourceId || !targetId) {
              throw new Error(
                `Edge references unknown tempId: source=${edge.sourceTempId}, target=${edge.targetTempId}`
              )
            }

            const [newEdge] = await tx
              .insert(graphEdges)
              .values({
                sourceNodeId: sourceId,
                targetNodeId: targetId,
                edgeType: edge.edgeType.trim(),
                metadata: { source: 'decision-capture' },
                createdBy: userId,
              })
              .returning({ id: graphEdges.id })

            committedEdgeIds.push(newEdge.id)
          }
        }, 'commitDecision')

        log.info('Decision committed successfully', {
          nodeCount: committedNodeIds.length,
          edgeCount: committedEdgeIds.length,
        })

        return {
          success: true,
          committedNodeIds,
          committedEdgeIds,
        }
      } catch (error) {
        log.error('Failed to commit decision', {
          error: error instanceof Error ? error.message : String(error),
        })

        return {
          success: false,
          committedNodeIds: [],
          committedEdgeIds: [],
          error: error instanceof Error ? error.message : 'Failed to commit decision',
        }
      }
    },
  }
}

function createValidateCompletenessTool(): Tool<ValidateCompletenessArgs, ValidateCompletenessResult> {
  return {
    description: `Check whether a decision subgraph meets the completeness criteria. A complete decision needs: (1) at least one decision node, (2) a person connected via PROPOSED or APPROVED_BY, (3) evidence or constraint connected via INFORMED or CONSTRAINED, (4) a condition connected via CONDITION.`,
    inputSchema: jsonSchema<ValidateCompletenessArgs>({
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: 'Nodes to validate',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              nodeType: { type: 'string' },
            },
            required: ['id', 'nodeType'],
          },
        },
        edges: {
          type: 'array',
          description: 'Edges to validate',
          items: {
            type: 'object',
            properties: {
              sourceNodeId: { type: 'string' },
              targetNodeId: { type: 'string' },
              edgeType: { type: 'string' },
            },
            required: ['sourceNodeId', 'targetNodeId', 'edgeType'],
          },
        },
      },
      required: ['nodes', 'edges'],
    }),
    execute: async (args: ValidateCompletenessArgs): Promise<ValidateCompletenessResult> => {
      log.info('Validating decision completeness', {
        nodeCount: args.nodes.length,
        edgeCount: args.edges.length,
      })

      return validateDecisionCompleteness(args.nodes, args.edges)
    },
  }
}

// ============================================
// Public Factory
// ============================================

/**
 * Create all decision capture tools for use in a streaming request.
 * The userId is needed for commit_decision to set createdBy on graph nodes/edges.
 */
export function createDecisionCaptureTools(userId: number): Record<string, Tool> {
  return {
    search_graph_nodes: createSearchGraphNodesTool(),
    propose_decision: createProposeDecisionTool(),
    commit_decision: createCommitDecisionTool(userId),
    validate_completeness: createValidateCompletenessTool(),
  }
}
