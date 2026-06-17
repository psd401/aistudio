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
import type { McpToolDefinition, McpToolResult } from "@/lib/mcp/types";

export type { ToolSurface, ToolCatalogSource };

/** HTTP methods a REST-surfaced tool endpoint can use. */
export type RestMethod = "get" | "post" | "put" | "patch" | "delete";

/**
 * REST binding for a `rest`-surfaced catalog tool — the metadata the
 * catalog→OpenAPI generator needs to emit the tool's path + operation. Kept on
 * the manifest entry (code tools); the generator reads `TOOL_MANIFEST` directly.
 */
export interface ToolRestBinding {
  /** HTTP method (lowercase, OpenAPI operation key). */
  method: RestMethod;
  /** OpenAPI path template, e.g. `/api/v1/assistants/{id}/execute`. */
  path: string;
  /** One-line operation summary for the generated spec. */
  summary: string;
  /** Optional longer description. */
  description?: string;
  /** `operationId` for the generated operation; defaults to the identifier. */
  operationId?: string;
}

/**
 * Per-surface scope overrides. A tool exposed on multiple surfaces often needs a
 * different scope vocabulary per surface (e.g. MCP `mcp:execute_assistant` vs REST
 * `assistants:execute`). When a surface key is present, it REPLACES `requiredScopes`
 * for that surface; otherwise `requiredScopes` applies. Without this, a multi-
 * surface tool would force callers to hold the union of every surface's scopes
 * (scope filtering is all-of), which is wrong. (#924 follow-up.)
 */
export type SurfaceScopes = Partial<Record<ToolSurface, string[]>>;

/**
 * Discriminated result of `ToolCatalog.dispatch()`. Carries the failure reason as
 * a typed field rather than encoding it in a human-readable message string, so
 * callers (e.g. the MCP JSON-RPC handler) map to protocol error codes by matching
 * on `reason` — not by sniffing message text that can change or be localized.
 */
export type ToolDispatchResult =
  | { ok: true; result: McpToolResult }
  | { ok: false; reason: "unknown" | "scope_denied" | "no_handler" };

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
  /**
   * Per-surface scope overrides. When the listing/dispatch surface has an entry
   * here, it replaces `requiredScopes` for that surface (e.g. REST uses
   * `assistants:execute` while MCP uses `mcp:execute_assistant`).
   */
  surfaceScopes?: SurfaceScopes;
  /** When false, internal agent loops may NOT invoke this tool. */
  agentCallable: boolean;
  /** Where this entry comes from. */
  source: ToolCatalogSource;
  /** Whether the tool is currently exposed. */
  isActive: boolean;
  /**
   * UI metadata for selectable `ai_sdk` chat tools — present only for tools the
   * Nexus tool selector renders. Lets the catalog be the single source for tool
   * display + model gating, not just identity/scope. (#924 follow-up.)
   */
  displayName?: string;
  /** UI grouping (`search` | `code` | `analysis` | `creative` | `media`). */
  category?: string;
  /** Model-capability keys; the tool shows for a model with ANY of these. */
  requiredCapabilities?: string[];
  /**
   * Handler dispatch reference. For `source = 'code'` this is the manifest
   * handler key. For `assistant`/`skill` it is a pointer the dispatcher resolves
   * (e.g. `assistant:42`).
   */
  handlerRef?: string;
}

/**
 * A single code-defined tool. Lives in the TypeScript manifest and is reconciled
 * into the `tool_catalog` table on boot (`source = 'code'`). Pure metadata: the
 * in-process MCP handler is NOT held here — `ToolCatalog` resolves it lazily at
 * dispatch time (keyed by the wire `name`) so the manifest does not drag the
 * handler/auth/`node:crypto` graph into the Edge-compiled boot-sync bundle.
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
   * Per-surface scope overrides — see {@link SurfaceScopes}. Lets a multi-surface
   * tool carry, e.g., `mcp:execute_assistant` on `mcp` and `assistants:execute`
   * on `rest` without forcing callers to hold both.
   */
  surfaceScopes?: SurfaceScopes;
  /**
   * REST binding for `rest`-surfaced tools — consumed by the catalog→OpenAPI
   * generator (`scripts/openapi/generate-from-catalog.ts`). Required when
   * `surfaces` includes `rest`.
   */
  rest?: ToolRestBinding;
  /**
   * When false, internal agent loops may NOT invoke this tool even if the scope
   * allows it (human-only / destructive guard). Defaults to true.
   */
  agentCallable?: boolean;
  /**
   * UI metadata for selectable `ai_sdk` chat tools — present only for tools the
   * Nexus tool selector renders. Universal/always-on tools omit these. The
   * catalog manifest populates them from `lib/tools/catalog/ai-sdk-tools.ts`.
   */
  displayName?: string;
  /** UI grouping (`search` | `code` | `analysis` | `creative` | `media`). */
  category?: string;
  /** Model-capability keys; the tool shows for a model with ANY of these. */
  requiredCapabilities?: string[];
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
