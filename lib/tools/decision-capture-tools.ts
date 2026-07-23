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
import { createLogger, generateRequestId } from '@/lib/logger'
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
import {
  commitDecisionSubgraph,
  describeDecisionError,
} from '@/lib/graph/decision-capture-service'

import type {
  SearchGraphNodesArgs,
  SearchGraphNodesResult,
  ProposeDecisionArgs,
  ProposeDecisionResult,
  CommitDecisionArgs,
  CommitDecisionResult,
} from './decision-capture-types'

// Re-export types for consumers
export type {
  SearchGraphNodesArgs,
  SearchGraphNodesResult,
  ProposedNode,
  ProposedEdge,
  ProposeDecisionArgs,
  ProposeDecisionResult,
  CommitDecisionArgs,
  CommitDecisionResult,
} from './decision-capture-types'

const log = createLogger({ module: 'decision-capture-tools' })


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
          minimum: 1,
          maximum: 50,
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
        { limit: Math.min(args.limit ?? 10, 50) }
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
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              tempId: { type: 'string', description: 'Temporary ID for edge references (e.g., "node-1")' },
              name: { type: 'string', description: 'Node name' },
              nodeType: { type: 'string', description: 'Node type (decision, evidence, constraint, reasoning, person, condition, request, policy, outcome)' },
              description: { type: 'string', description: 'Node description (nullable)' },
              existingNodeId: { type: 'string', description: 'If linking to an existing node, its UUID. Omit to create new.' },
              isPrimary: { type: 'boolean', description: 'Mark the decision that was actually adopted. Required when more than one "decision"-typed node is present (rejected alternatives are also typed "decision").' },
            },
            required: ['tempId', 'name', 'nodeType'],
          },
        },
        edges: {
          type: 'array',
          description: 'Proposed edges connecting nodes by their tempIds',
          maxItems: 200,
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
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              tempId: { type: 'string' },
              name: { type: 'string' },
              nodeType: { type: 'string' },
              description: { type: 'string' },
              existingNodeId: { type: 'string' },
              isPrimary: { type: 'boolean', description: 'Mark the decision that was actually adopted. Required when more than one "decision"-typed node is present.' },
            },
            required: ['tempId', 'name', 'nodeType'],
          },
        },
        edges: {
          type: 'array',
          description: 'Edges to commit (same format as propose_decision)',
          maxItems: 200,
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
      const requestId = generateRequestId()
      log.info('Committing decision to graph', {
        requestId,
        summary: args.summary.substring(0, 100),
        nodeCount: args.nodes.length,
        edgeCount: args.edges.length,
        userId,
      })

      try {
        // Route through the shared decision-capture service (Issue #1251) so the
        // conversational channel inherits vocabulary enforcement, self-reference /
        // duplicate-edge guards, typed errors, existing-node reuse, and completeness
        // recomputation. The old inline transaction has been removed.
        const result = await commitDecisionSubgraph(
          { nodes: args.nodes, edges: args.edges, summary: args.summary },
          userId,
          requestId
        )

        log.info('Decision committed successfully', {
          requestId,
          nodeCount: result.committedNodeIds.length,
          edgeCount: result.committedEdgeIds.length,
          completenessScore: result.completenessScore,
        })

        return {
          success: true,
          committedNodeIds: result.committedNodeIds,
          committedEdgeIds: result.committedEdgeIds,
          completenessScore: result.completenessScore,
          completenessMethod: result.completenessMethod,
          warnings: result.warnings,
        }
      } catch (error) {
        // Log the raw error for diagnostics; describeDecisionError yields the
        // friendly message (never a raw Postgres string) that the commit tool
        // UI renders directly.
        log.error('Failed to commit decision', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        })

        return {
          success: false,
          committedNodeIds: [],
          committedEdgeIds: [],
          error: describeDecisionError(error),
        }
      }
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
  }
}
