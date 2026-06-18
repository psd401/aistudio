/**
 * Agentic Assistant Runtime — shared types (Issue #926, Epic #922 workstream #4).
 *
 * The agentic runtime extends Assistant Architect with a model loop that can call
 * tools (catalog tools + per-user MCP connectors), reason over the results, and
 * continue until done. These types are the contract between the tool resolver
 * (`tool-resolver.ts`) and the execution route that drives the loop.
 */

import type { ToolSet } from "ai";
import type { McpConnectorToolsResult } from "@/lib/mcp/connector-types";

/**
 * Resolved tool set for a single agentic run, plus the metadata the route needs
 * to render the tool-call timeline and to clean up MCP clients afterward.
 */
export interface ResolvedAgentTools {
  /** Merged AI SDK tool set: catalog (internal-surface) tools + connector tools. */
  tools: ToolSet;
  /**
   * Catalog tool identifiers (`domain.action`) that were requested by the author
   * but DROPPED because the caller's scopes don't permit them, the tool is not
   * `agentCallable`, or it isn't exposed on the `internal` surface. Surfaced for
   * audit/observability — the model never sees these.
   */
  deniedToolIdentifiers: string[];
  /** Catalog tool identifiers actually exposed to the model this run. */
  grantedToolIdentifiers: string[];
  /** Open MCP connector clients; caller MUST close these in onFinish/onError. */
  connectorResults: McpConnectorToolsResult[];
  /** MCP connector server IDs that failed to resolve (non-fatal). */
  failedConnectorIds: string[];
}

/** Inputs required to resolve an agentic run's tools. */
export interface ResolveAgentToolsParams {
  /** Author-configured catalog tool identifiers (`domain.action`). */
  enabledToolIdentifiers: string[];
  /** Author-configured MCP connector server IDs (Nexus #774). */
  enabledConnectorIds: string[];
  /** The EXECUTING caller — tools are intersected with these scopes. */
  caller: {
    userId: number;
    cognitoSub: string;
    /** Caller's API scopes (role-derived via getScopesForRoles). */
    scopes: string[];
    /** Caller's role names — needed to resolve per-user MCP connector access. */
    roleNames: string[];
    /** ID token for MCP connectors that proxy the caller's identity. */
    idToken?: string;
  };
  /** Correlates dispatch + audit logs to the execution request. */
  requestId: string;
  /**
   * Whether THIS run is approved to execute destructive (state-changing) tools.
   * When false (default), destructive tools are gated: the model sees a
   * confirmation-required message and the tool is NOT executed (Issue #926).
   */
  approveDestructive?: boolean;
  /**
   * Optional audit sink invoked once per tool invocation (after it completes),
   * so the execution route can persist a tool-invocation event. Never throws back
   * into the model loop — failures are swallowed by the resolver.
   */
  onToolInvocation?: (event: ToolInvocationAudit) => void | Promise<void>;
}

/** One tool invocation, captured for the audit log + execution timeline. */
export interface ToolInvocationAudit {
  /** Catalog identifier (`domain.action`) of the invoked tool. */
  toolIdentifier: string;
  /** Wire/model-facing tool name. */
  toolName: string;
  /** Sanitized, size-bounded arguments the model passed. */
  args: Record<string, unknown>;
  /** Whether the dispatch succeeded. */
  ok: boolean;
  /** Failure reason when `ok` is false (catalog dispatch reason or error text). */
  error?: string;
  /** Wall-clock duration of the dispatch in milliseconds. */
  durationMs: number;
  /** Invoking principal (the executing caller's user id). */
  userId: number;
  /**
   * True when the invocation was a destructive tool BLOCKED pending human
   * confirmation (the handler was not executed). Lets the audit/timeline
   * distinguish a gated call from a real failure (Issue #926).
   */
  confirmationRequired?: boolean;
}

/** Runtime limits enforced per agentic run. */
export interface AgentRunLimits {
  /** Max tool-use round-trips (AI SDK `maxSteps`). */
  maxSteps: number;
  /** Wall-clock timeout in seconds. */
  timeoutSeconds: number;
  /** Per-run cost cap in whole US cents, or null for no cap. */
  costCapCents: number | null;
}

/** Hard ceilings the route clamps author-supplied limits to (defense in depth). */
export const AGENT_LIMIT_CEILINGS = {
  maxSteps: 50,
  timeoutSeconds: 900,
} as const;

/** Defaults applied when an assistant has no explicit limit configured. */
export const AGENT_LIMIT_DEFAULTS = {
  maxSteps: 10,
  timeoutSeconds: 300,
  costCapCents: null as number | null,
} as const;
