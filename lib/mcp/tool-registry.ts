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

import type { McpToolDefinition, McpToolProperty } from "./types"
import { CONTENT_MCP_TOOLS } from "./content-tools"

// ============================================
// Tool Definitions
// ============================================

const ASSISTANT_IMPORT_PROMPT_SCHEMA: McpToolProperty = {
  type: "object",
  description: "One ordered prompt in the Assistant Architect graph.",
  required: ["name", "content", "model_name", "position"],
  properties: {
    name: {
      type: "string",
      description: "Prompt display name.",
    },
    content: {
      type: "string",
      description: "Prompt template content.",
      maxLength: 10_000_000,
    },
    system_context: {
      type: ["string", "null"],
      description: "Optional system context prepended to the prompt.",
      maxLength: 10_000_000,
    },
    model_name: {
      type: "string",
      description: "Portable active model id/name to resolve during import.",
    },
    position: {
      type: "integer",
      description: "Zero-based prompt ordering position.",
    },
    parallel_group: {
      type: ["integer", "null"],
      description: "Optional parallel execution group.",
    },
    input_mapping: {
      type: ["object", "null"],
      description: "Optional mapping whose values are input variable names.",
      additionalProperties: {
        type: "string",
        description: "Input variable name.",
      },
    },
    timeout_seconds: {
      type: ["integer", "null"],
      description: "Optional positive per-prompt timeout in seconds.",
      minimum: 1,
    },
    repository_ids: {
      type: "array",
      description:
        "Positive durable repository ids; at most 500 bindings per envelope in aggregate.",
      maxItems: 500,
      items: {
        type: "integer",
        description: "Durable repository id.",
        minimum: 1,
      },
    },
    enabled_tools: {
      type: "array",
      description: "Tool identifiers enabled for this prompt.",
      items: {
        type: "string",
        description: "Tool identifier.",
      },
    },
  },
}

const ASSISTANT_IMPORT_FIELD_SCHEMA: McpToolProperty = {
  type: "object",
  description: "One caller-supplied assistant input field.",
  required: ["name", "label", "field_type", "position"],
  properties: {
    name: {
      type: "string",
      description: "Input variable name.",
    },
    label: {
      type: "string",
      description: "Human-readable input label.",
    },
    field_type: {
      type: "string",
      description: "Supported input control type.",
      enum: [
        "short_text",
        "long_text",
        "select",
        "multi_select",
        "file_upload",
      ],
    },
    position: {
      type: "integer",
      description: "Zero-based field ordering position.",
    },
    options: {
      type: ["object", "null"],
      description: "Optional field-specific configuration.",
      additionalProperties: true,
    },
  },
}

const ASSISTANT_IMPORT_DEFINITION_SCHEMA: McpToolProperty = {
  type: "object",
  description: "Complete portable ExportFormat v1.0 assistant definition.",
  required: ["name", "prompts", "input_fields"],
  properties: {
    name: {
      type: "string",
      description: "Assistant name.",
      minLength: 1,
      maxLength: 255,
    },
    description: {
      type: "string",
      description: "Assistant description.",
    },
    status: {
      type: "string",
      description:
        "Portable status value; ignored because every mutation writes pending_approval.",
    },
    image_path: {
      type: ["string", "null"],
      description: "Optional assistant image path.",
    },
    is_parallel: {
      type: "boolean",
      description: "Whether prompt groups may execute in parallel.",
    },
    timeout_seconds: {
      type: ["integer", "null"],
      description: "Optional positive prompt-chain timeout in seconds.",
      minimum: 1,
    },
    mode: {
      type: "string",
      description: "Assistant execution mode.",
      enum: ["prompt_chain", "agentic"],
      default: "prompt_chain",
    },
    model_routing_mode: {
      type: "string",
      description: "Model-routing strategy.",
      enum: ["legacy", "standard", "advanced"],
      default: "legacy",
    },
    model_routing_family: {
      type: ["string", "null"],
      description:
        "Required for advanced routing and otherwise omitted or null.",
      enum: ["openai", "anthropic", "google", null],
    },
    agent_enabled_tools: {
      type: "array",
      description: "Agent tool identifiers available to the importing author.",
      items: {
        type: "string",
        description: "Agent tool identifier.",
      },
    },
    agent_enabled_connectors: {
      type: "array",
      description: "Connector identifiers visible to the importing author.",
      items: {
        type: "string",
        description: "Connector identifier.",
      },
    },
    agent_max_steps: {
      type: "integer",
      description: "Maximum agentic reasoning steps.",
      minimum: 1,
      maximum: 50,
      default: 10,
    },
    agent_timeout_seconds: {
      type: "integer",
      description: "Agentic wall-clock timeout in seconds.",
      minimum: 1,
      maximum: 900,
      default: 300,
    },
    agent_cost_cap_cents: {
      type: ["integer", "null"],
      description: "Optional positive per-run cost cap in cents.",
      minimum: 1,
    },
    agent_max_requests_per_hour: {
      type: ["integer", "null"],
      description: "Optional positive assistant-wide hourly request cap.",
      minimum: 1,
    },
    retrieval_scope: {
      type: ["object", "null"],
      description: "Optional Atrium retrieval scope.",
      properties: {
        collectionId: {
          type: ["string", "null"],
          description: "Optional collection identifier.",
        },
        tags: {
          type: "array",
          description: "Required content tags.",
          items: {
            type: "string",
            description: "Content tag.",
          },
        },
        maxVisibilityLevel: {
          type: "string",
          description: "Maximum admitted content visibility.",
          enum: ["private", "group", "internal", "public"],
        },
      },
    },
    prompts: {
      type: "array",
      description: "Ordered prompt graph, capped at 20 prompts.",
      maxItems: 20,
      items: ASSISTANT_IMPORT_PROMPT_SCHEMA,
    },
    input_fields: {
      type: "array",
      description: "Caller input fields, capped at 50.",
      maxItems: 50,
      items: ASSISTANT_IMPORT_FIELD_SCHEMA,
    },
  },
}

const ASSISTANT_IMPORT_ENVELOPE_PROPERTIES: Record<
  string,
  McpToolProperty
> = {
  version: {
    type: "string",
    description: "Export format version. Must be 1.0.",
    enum: ["1.0"],
    const: "1.0",
  },
  exported_at: {
    type: "string",
    description: "ISO timestamp from the portable export envelope.",
  },
  export_source: {
    type: "string",
    description: "Optional source label from the export envelope.",
  },
  assistants: {
    type: "array",
    description:
      "One to 100 complete portable Assistant Architect definitions.",
    minItems: 1,
    maxItems: 100,
    items: ASSISTANT_IMPORT_DEFINITION_SCHEMA,
  },
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "search_decisions",
    description:
      "Search decision graph nodes. Provide `q` for semantic (embedding-based) paraphrase search over decision nodes, or `query` for literal text (ILIKE) search. Returns paginated results.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description:
            "Semantic search query — returns paraphrase matches (embedding-based) over decision nodes. Falls back to literal search if embeddings are unavailable.",
        },
        query: {
          type: "string",
          description: "Literal text search (ILIKE) across node names and descriptions",
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
        consulted: {
          type: "array",
          items: { type: "string" },
          description: "DACI: people/roles consulted about the decision — each linked via a CONSULTED edge (max 20 items)",
        },
        notified: {
          type: "array",
          items: { type: "string" },
          description: "DACI: people/roles notified/informed of the decision — each linked via a NOTIFIED edge (max 20 items)",
        },
        supersedes: {
          type: "array",
          items: { type: "string" },
          description: "UUIDs of existing decision nodes this decision supersedes — each is marked status=superseded and linked SUPERSEDED_BY (max 20)",
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
    name: "create_assistant",
    description:
      "Create one or more Assistant Architects from an ExportFormat v1.0 envelope. Created assistants are owned by the caller and always enter pending_approval.",
    inputSchema: {
      type: "object",
      properties: ASSISTANT_IMPORT_ENVELOPE_PROPERTIES,
      required: ["version", "assistants"],
    },
  },
  {
    name: "update_assistant",
    description:
      "Replace an Assistant Architect from a single-assistant ExportFormat v1.0 envelope. Owners may update their own assistants; administrators may update any. Status always resets to pending_approval.",
    inputSchema: {
      type: "object",
      properties: {
        assistantId: {
          type: "integer",
          description: "Numeric ID of the assistant to replace.",
          minimum: 1,
        },
        ...ASSISTANT_IMPORT_ENVELOPE_PROPERTIES,
        assistants: {
          ...ASSISTANT_IMPORT_ENVELOPE_PROPERTIES.assistants,
          description:
            "Exactly one complete portable Assistant Architect definition.",
          maxItems: 1,
        },
      },
      required: ["assistantId", "version", "assistants"],
    },
  },
  {
    name: "fork_assistant",
    description:
      "Fork a visible Assistant Architect into a new caller-owned pending_approval assistant. The source is not modified.",
    inputSchema: {
      type: "object",
      properties: {
        assistantId: {
          type: "number",
          description: "Numeric ID of the visible assistant to fork.",
        },
        name: {
          type: "string",
          description:
            "Optional name for the fork. Defaults to the source assistant name.",
        },
      },
      required: ["assistantId"],
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
      "Get a self-contained decision package for a node: the decision plus its evidence, constraints, reasoning, persons, conditions, outcomes, and supersession chain, gathered by a depth-bounded graph expansion.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "UUID of the graph node to retrieve",
        },
        depth: {
          type: "number",
          description: "Graph-expansion radius in hops (1-3, default 2)",
          default: 2,
        },
      },
      required: ["nodeId"],
    },
  },
  {
    // Platform capability catalog (Issue #1100). A read-only meta-tool: a LIVE
    // projection of AI Studio's own source-of-truth registries so the agent's
    // understanding of what the platform can do never drifts from the deployed
    // code. Returns `actions[]` (invocable tools, each flagged `agentInvocable`
    // when reachable over MCP), `features[]` (role-gated UI features the agent
    // steers users to), and a `scopes[]` reference.
    name: "describe_capabilities",
    description:
      "Describe what AI Studio can do, live from the app's own registries. Returns invocable actions (with the surfaces/scopes each needs and whether the agent can invoke it over MCP), role-gated UI features to steer users toward, and a scope reference. Use this to discover current capabilities instead of relying on a static list.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description:
            "Limit the response to one section. Defaults to 'all'.",
          enum: ["actions", "features", "scopes", "all"],
        },
        surface: {
          type: "string",
          description:
            "Only include actions exposed on this surface (does not affect features/scopes).",
          enum: ["mcp", "ai_sdk", "rest", "internal"],
        },
        query: {
          type: "string",
          description:
            "Case-insensitive substring filter across identifier, name, description, and scope.",
        },
      },
    },
  },
  {
    name: "repositories_list",
    description:
      "List durable repositories the authenticated user can currently access.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional case-insensitive name or description filter.",
        },
        limit: {
          type: "number",
          description: "Maximum repositories to return (1-50, default 50).",
          default: 50,
        },
      },
    },
  },
  {
    name: "repositories_describe",
    description:
      "Describe one durable repository if the authenticated user can currently access it.",
    inputSchema: {
      type: "object",
      properties: {
        repositoryId: {
          type: "number",
          description: "Repository numeric id.",
        },
      },
      required: ["repositoryId"],
    },
  },
  {
    name: "repositories_search",
    description:
      "Search one or more authorized repositories using the active retrieval generation and live repository and segment ACLs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        repositoryIds: {
          type: "array",
          items: { type: "number" },
          description:
            "Repository ids to search. Omit to search every accessible durable repository.",
        },
        mode: {
          type: "string",
          enum: ["keyword", "vector", "hybrid"],
          description: "Retrieval mode (default hybrid).",
        },
        modalities: {
          type: "array",
          items: { type: "string" },
          description: "Optional text, image, audio, video, or table filters.",
        },
        limit: {
          type: "number",
          description: "Maximum results (1-50, default 10).",
          default: 10,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "repositories_get_source",
    description:
      "Get exact citation source segments from an authorized repository's active generation and current item version.",
    inputSchema: {
      type: "object",
      properties: {
        repositoryId: { type: "number", description: "Repository numeric id." },
        itemId: { type: "number", description: "Repository item numeric id." },
        chunkId: {
          type: "number",
          description: "Optional exact source chunk id.",
        },
        limit: {
          type: "number",
          description: "Maximum source segments (1-50, default 20).",
          default: 20,
        },
      },
      required: ["repositoryId", "itemId"],
    },
  },
  {
    name: "repositories_list_changes",
    description:
      "List item changes in authorized repositories using a stable opaque cursor.",
    inputSchema: {
      type: "object",
      properties: {
        repositoryIds: {
          type: "array",
          items: { type: "number" },
          description: "One or more repository ids.",
        },
        cursor: {
          type: "string",
          description: "Opaque cursor returned by the previous call.",
        },
        limit: {
          type: "number",
          description: "Maximum changes (1-100, default 50).",
          default: 50,
        },
      },
      required: ["repositoryIds"],
    },
  },
  // Atrium content tools (Phase 5, Issue #1055) — listed so scoped callers
  // discover them via tools/list.
  ...CONTENT_MCP_TOOLS,
]
