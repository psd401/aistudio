/**
 * MCP Tool Registry
 * Defines available MCP tools (name / description / inputSchema).
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 *
 * NOTE (epic #922 audit): the legacy `TOOL_SCOPE_MAP` and the
 * `getToolsForScopes()` / `hasToolScope()` helpers were REMOVED. They had no
 * live callers and silently drifted from the real enforcement point: scope
 * checks live exclusively in the unified tool catalog (`lib/tools/catalog/`),
 * whose entries carry `requiredScopes` consumed by both `tools/list` and
 * `tools/call` (#924). This module now only declares the MCP tool definitions
 * the catalog manifest projects.
 */

import type { McpToolDefinition } from "./types"
import { CONTENT_MCP_TOOLS } from "./content-tools"

// ============================================
// Tool Definitions
// ============================================

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "search_decisions",
    description:
      "Search decision graph nodes by type, class, or text query. Returns paginated results.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text search across node names and descriptions",
        },
        nodeType: {
          type: "string",
          description: "Filter by node type (e.g., decision, policy, guideline)",
        },
        nodeClass: {
          type: "string",
          description: "Filter by node class (e.g., strategic, operational)",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (1-100, default 50)",
          default: 50,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor from previous response",
        },
      },
    },
  },
  {
    name: "capture_decision",
    description:
      `Capture a structured decision with full context (evidence, constraints, reasoning, alternatives). Creates a decision subgraph with completeness scoring.

Example:
{
  "decision": "Use PostgreSQL for data layer",
  "decidedBy": "Engineering Team",
  "reasoning": "Strong ACID guarantees needed for financial data",
  "evidence": ["Benchmark shows 3x throughput vs MySQL"],
  "constraints": ["Must support JSONB queries"],
  "conditions": ["Revisit if write volume exceeds 50k ops/s"],
  "alternatives_considered": ["MongoDB", "DynamoDB"],
  "relatedTo": ["550e8400-e29b-41d4-a716-446655440000"]
}`,
    inputSchema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          description: "The decision text (max 2000 chars)",
        },
        decidedBy: {
          type: "string",
          description: "Who made the decision (person or role, max 500 chars)",
        },
        reasoning: {
          type: "string",
          description: "Why this decision was made (max 5000 chars)",
        },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Supporting evidence or data points (max 20 items)",
        },
        constraints: {
          type: "array",
          items: { type: "string" },
          description: "Constraints or limiting factors (max 20 items)",
        },
        conditions: {
          type: "array",
          items: { type: "string" },
          description: "Conditions under which the decision should be revisited (max 20 items)",
        },
        alternatives_considered: {
          type: "array",
          items: { type: "string" },
          description: "Alternative options that were considered and rejected (max 20 items)",
        },
        relatedTo: {
          type: "array",
          items: { type: "string" },
          description: "UUIDs of existing graph nodes to link via CONTEXT edges (max 50)",
        },
        agentId: {
          type: "string",
          description: "Identifier for the agent capturing this decision (max 200 chars)",
        },
        metadata: {
          type: "object",
          description: "Additional metadata to attach to the decision node (max 10KB serialized)",
        },
      },
      required: ["decision", "decidedBy"],
    },
  },
  {
    name: "execute_assistant",
    description:
      "Execute an AI assistant with the given inputs and return the final text result.",
    inputSchema: {
      type: "object",
      properties: {
        assistantId: {
          type: "number",
          description: "Numeric ID of the assistant to execute",
        },
        inputs: {
          type: "object",
          description:
            "Key-value input fields required by the assistant. Keys are field names, values are strings.",
        },
      },
      required: ["assistantId", "inputs"],
    },
  },
  {
    name: "list_assistants",
    description:
      "List AI assistants the authenticated user has access to execute.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status",
          enum: ["draft", "pending_approval", "approved", "rejected", "disabled"],
        },
        search: {
          type: "string",
          description: "Search assistants by name",
        },
        limit: {
          type: "number",
          description: "Maximum results (1-100, default 50)",
          default: 50,
        },
        cursor: {
          type: "string",
          description: "Pagination cursor",
        },
      },
    },
  },
  {
    name: "get_decision_graph",
    description:
      "Get details of a specific decision node and all its connections (incoming and outgoing edges).",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "UUID of the graph node to retrieve",
        },
      },
      required: ["nodeId"],
    },
  },
  // Atrium content tools (Phase 5, Issue #1055) — listed so scoped callers
  // discover them via tools/list.
  ...CONTENT_MCP_TOOLS,
]
