/**
 * Unified Tool Catalog — shared types
 *
 * Issue #924 (Epic #922, workstream #2). These types are the contract shared by
 * the code manifest (`manifest.ts`), the boot-time sync (`sync.ts`), and the
 * runtime catalog (`catalog.ts`).
 *
 * A "tool" here is an *invocable unit* AI Studio exposes to callers — distinct
 * from a "capability" (#923), which is a role-gated UI feature flag. Externally
 * *consumed* MCP tools (per-user connector tools resolved by
 * `lib/mcp/connector-service.ts`) are deliberately NOT cataloged here; the
 * catalog tracks only tools AI Studio itself owns and exposes.
 */

import type {
  ToolSurface,
  ToolCatalogSource,
} from "@/lib/db/schema/tables/tool-catalog";
import type { McpToolDefinition, McpToolHandler } from "@/lib/mcp/types";

export type { ToolSurface, ToolCatalogSource };

/**
 * The merged, runtime-facing view of a single tool — produced by `ToolCatalog`
 * from either a manifest entry (`source = 'code'`) or a DB row
 * (`source = 'assistant' | 'skill'`).
 */
export interface ToolCatalogEntry {
  /** Stable `domain.action` ID. Immutable once shipped. */
  identifier: string;
  /** Version string (`v1`, `v2`, ...). */
  version: string;
  /** Model/human-facing tool name (what MCP `tools/list` reports as `name`). */
  name: string;
  /** Model/human-readable description. */
  description: string;
  /** JSON Schema for tool input (MCP `inputSchema` shape). */
  inputSchema: McpToolDefinition["inputSchema"];
  /** Optional JSON Schema for tool output. */
  outputSchema?: Record<string, unknown>;
  /** Surfaces that expose this tool. */
  surfaces: ToolSurface[];
  /** API scope strings the caller must hold to see/invoke this tool. */
  requiredScopes: string[];
  /** When false, internal agent loops may NOT invoke this tool. */
  agentCallable: boolean;
  /** Where this entry comes from. */
  source: ToolCatalogSource;
  /** Whether the tool is currently exposed. */
  isActive: boolean;
  /**
   * Handler dispatch reference. For `source = 'code'` this is the manifest
   * handler key. For `assistant`/`skill` it is a pointer the dispatcher resolves
   * (e.g. `assistant:42`).
   */
  handlerRef?: string;
}

/**
 * A single code-defined tool. Lives in the TypeScript manifest and is reconciled
 * into the `tool_catalog` table on boot (`source = 'code'`). The `handler` is the
 * in-process function the catalog dispatcher calls for MCP `tools/call`.
 */
export interface ToolManifestEntry {
  /** Stable `domain.action` ID. Immutable once shipped. */
  identifier: string;
  /** Version string. Defaults to `v1` if omitted. */
  version?: string;
  /** Model/human-facing tool name (the MCP wire `name`). */
  name: string;
  /** Description shown to models and humans. */
  description: string;
  /** JSON Schema for tool input. */
  inputSchema: McpToolDefinition["inputSchema"];
  /** Optional JSON Schema for tool output. */
  outputSchema?: Record<string, unknown>;
  /** Surfaces this tool is exposed on. */
  surfaces: ToolSurface[];
  /** API scopes required to see/invoke this tool. */
  requiredScopes: string[];
  /**
   * When false, internal agent loops may NOT invoke this tool even if the scope
   * allows it (human-only / destructive guard). Defaults to true.
   */
  agentCallable?: boolean;
  /**
   * In-process handler invoked for MCP `tools/call`. The catalog dispatcher
   * routes to this by `identifier`. Optional for surfaces (e.g. pure `ai_sdk`
   * provider-native tools) that do not dispatch through the MCP handler path.
   */
  handler?: McpToolHandler;
}

/** Filter inputs for `ToolCatalog.list()`. */
export interface ToolCatalogFilter {
  /** Caller's granted scopes. `*` grants everything. Omit to skip scope filtering. */
  scopes?: string[];
  /** Only return tools exposed on this surface. */
  surface?: ToolSurface;
  /** When true, exclude tools with `agentCallable = false`. */
  agentOnly?: boolean;
  /** Include inactive tools (default: active only). */
  includeInactive?: boolean;
}
