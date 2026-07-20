/**
 * Tool Catalog Manifest
 *
 * Issue #924 (Epic #922, workstream #2) — the code-defined half of the hybrid
 * tool catalog. Add an entry here, restart the server, and the boot-time sync
 * (`lib/tools/catalog/sync.ts`) reconciles it into the `tool_catalog` table with
 * `source = 'code'`. No SQL migration, no per-surface wiring.
 *
 * This is the direct parallel of `lib/capabilities/manifest.ts` (#923), but for
 * *invocable tools* rather than role-gated UI feature flags.
 *
 * ## Identifier convention (decision for this issue)
 *
 * `domain.action` (dot-separated), e.g. `decisions.search`, `assistants.execute`.
 * Chosen over the legacy MCP wire names (`search_decisions`) because the catalog
 * spans multiple surfaces and the `domain.action` form namespaces cleanly and
 * reads well in OpenAPI / REST paths. The MCP wire `name` stays the snake_case
 * value (e.g. `search_decisions`) for backward compatibility with existing MCP
 * clients — that is the `name` field, distinct from `identifier`.
 *
 * ## Rules
 *
 * - `identifier` (+ `version`) is the stable key. Never change a shipped
 *   identifier; it would orphan DB rows and references.
 * - The manifest owns `name`, `description`, schemas, `surfaces`,
 *   `requiredScopes`, `agentCallable`, and `handlerRef` for `source = 'code'`
 *   rows. The sync writes these; it never flips `is_active` (admin disables in
 *   the DB survive restarts).
 * - Removing an entry does NOT hard-delete the row; the sync deactivates it
 *   (and demotes it so a later re-add re-claims ownership).
 *
 * Assistant- and skill-derived tools are NOT listed here — they are written to
 * `tool_catalog` by their own lifecycle hooks with `source = 'assistant'` /
 * `'skill'` and merged at runtime by `ToolCatalog`.
 */

import { MCP_TOOLS } from "@/lib/mcp/tool-registry";
import type { McpToolDefinition } from "@/lib/mcp/types";
import { AGENT_TOOL_DESCRIPTORS } from "@/lib/agents/agent-tools/descriptors";
import { AI_SDK_TOOLS } from "./ai-sdk-tools";
import type {
  ToolManifestEntry,
  ToolRestBinding,
  ToolSurface,
} from "./types";
import { compareVersionsDesc } from "./utils";

/** Source value applied to every manifest-managed catalog row. */
export const MANIFEST_TOOL_SOURCE = "code" as const;

/**
 * Map each existing MCP wire tool to its canonical catalog identifier + scope.
 * Keeps the schema/description single-sourced from `MCP_TOOLS` while assigning
 * the new `domain.action` identifier and the required scope.
 */
interface McpCatalogMapping {
  identifier: string;
  /** MCP-surface scope (the base `requiredScopes`). */
  requiredScope: string;
  /**
   * Present when the tool is ALSO exposed on the REST surface by an existing
   * `/api/v1` route. `scopes` are the REST scope(s) (distinct from the MCP scope);
   * `binding` is the OpenAPI path/operation the catalog→OpenAPI generator emits.
   */
  rest?: { scopes: string[]; binding: ToolRestBinding };
  /**
   * Scope(s) a caller must hold to invoke this tool from the `internal` agent
   * loop (Issue #926). The MCP scope (`mcp:*`) is the right grant for an
   * in-process agent calling the same handler: the agent runs in the caller's
   * session, and these scopes are what an app session already carries. Present
   * here means the tool is exposed on the `internal` surface so the agentic
   * runtime can resolve it via `catalog.list({ surface: 'internal' })`.
   */
  internalScopes?: string[];
  /**
   * When true, the tool is destructive / state-changing (writes data, deletes,
   * external side effect) and an agent loop must obtain human confirmation before
   * executing it (Issue #926). Defaults to false.
   */
  destructive?: boolean;
  /**
   * Catalog version for this tool (defaults to "v1"). A published version's
   * input/output schema is FROZEN by the sync (Issue #927) — whenever a tool's
   * schema in `lib/mcp/tool-registry.ts` changes, bump this (v1 -> v2 -> ...)
   * or the sync refuses the update and the deployed catalog keeps serving the
   * old contract while logging "Tool version immutability violation" on every
   * boot.
   */
  version?: string;
}

const MCP_TOOL_CATALOG_MAP: Record<string, McpCatalogMapping> = {
  // Platform capability catalog meta-tool (Issue #1100). Read-only projection of
  // AI Studio's own registries. Gated by the low, broadly-granted `platform:read`
  // scope so any authenticated caller (student/staff/administrator, and the
  // scoped agent) can discover current capabilities. Non-destructive. Exposed on
  // the `internal` surface too so an in-process agent loop can also read it.
  describe_capabilities: {
    identifier: "platform.describe_capabilities",
    requiredScope: "platform:read",
    internalScopes: ["platform:read"],
  },
  search_decisions: {
    identifier: "decisions.search",
    requiredScope: "mcp:search_decisions",
    internalScopes: ["mcp:search_decisions"],
    // v2: #1252 added semantic `q` to the input schema.
    version: "v2",
  },
  capture_decision: {
    identifier: "decisions.capture",
    requiredScope: "mcp:capture_decision",
    internalScopes: ["mcp:capture_decision"],
    // Writes new decision-graph nodes/edges — gated behind human confirmation in
    // an agent loop (#926).
    destructive: true,
    // v2: #1252 added supersedes/consulted/notified to the input schema.
    version: "v2",
  },
  execute_assistant: {
    identifier: "assistants.execute",
    requiredScope: "mcp:execute_assistant",
    internalScopes: ["mcp:execute_assistant"],
    rest: {
      // REST callers use `assistants:execute` (see app/api/v1/assistants/[id]/execute);
      // distinct from the MCP scope, hence surfaceScopes rather than a shared array.
      scopes: ["assistants:execute"],
      binding: {
        method: "post",
        path: "/api/v1/assistants/{id}/execute",
        summary: "Execute an assistant",
        description:
          "Execute an assistant architect by id. Returns an SSE stream (default) or a 202 job (Accept: application/json).",
        operationId: "executeAssistant",
        successResponses: {
          "200": "SSE stream of execution events (default Accept: text/event-stream).",
          "202": "Async job accepted; poll for completion (Accept: application/json).",
        },
      },
    },
  },
  list_assistants: {
    identifier: "assistants.list",
    requiredScope: "mcp:list_assistants",
    internalScopes: ["mcp:list_assistants"],
    rest: {
      // REST list route uses `assistants:list` (see app/api/v1/assistants GET).
      scopes: ["assistants:list"],
      binding: {
        method: "get",
        path: "/api/v1/assistants",
        summary: "List assistants available for API execution",
        operationId: "listAssistants",
      },
    },
  },
  get_decision_graph: {
    identifier: "decisions.graph_get",
    requiredScope: "mcp:get_decision_graph",
    internalScopes: ["mcp:get_decision_graph"],
    // v2: #1252 added `depth` to the input schema (decision-package retrieval).
    version: "v2",
  },
  // Atrium content tools (Phase 5, Issue #1055). MCP-only catalog entries (the
  // REST surface is hand-documented in docs/API/v1/openapi.yaml, not generated
  // here). Mutations are `destructive` so an agent loop confirms before writing.
  // The internal surface is exposed so scheduled/agentic runs (§25) can resolve
  // them, gated by the content scope.
  create_document: {
    identifier: "content.create_document",
    requiredScope: "content:create",
    internalScopes: ["content:create"],
    destructive: true,
    // v2: `codeEncoding` added to the input schema (#1245 E2BIG fix).
    version: "v2",
  },
  create_artifact: {
    identifier: "content.create_artifact",
    requiredScope: "content:create",
    internalScopes: ["content:create"],
    destructive: true,
    // v2: `codeEncoding` added to the input schema (#1245 E2BIG fix).
    version: "v2",
  },
  get_content: {
    identifier: "content.get",
    requiredScope: "content:read",
    internalScopes: ["content:read"],
  },
  list_content: {
    identifier: "content.list",
    requiredScope: "content:read",
    internalScopes: ["content:read"],
  },
  update_content: {
    identifier: "content.update",
    requiredScope: "content:update",
    internalScopes: ["content:update"],
    destructive: true,
  },
  create_version: {
    identifier: "content.create_version",
    requiredScope: "content:update",
    internalScopes: ["content:update"],
    destructive: true,
    // v2: `codeEncoding` added to the input schema (#1245 E2BIG fix).
    version: "v2",
  },
  set_visibility: {
    identifier: "content.set_visibility",
    requiredScope: "content:update",
    internalScopes: ["content:update"],
    destructive: true,
    // v2: grants description gained the 'group' kind (directory groups, #1206).
    version: "v2",
  },
  publish_content: {
    identifier: "content.publish",
    requiredScope: "content:publish_internal",
    internalScopes: ["content:publish_internal"],
    destructive: true,
  },
  // Unpublish shares publish's authority model (the §26.4 public-takedown gate
  // lives in publishService.unpublish, not in a scope here).
  unpublish_content: {
    identifier: "content.unpublish",
    requiredScope: "content:publish_internal",
    internalScopes: ["content:publish_internal"],
    destructive: true,
  },
  // OKF interoperability (Phase 8, #1103, §36.4). Export is a read/serialization
  // (content:read; the §26.4 public gate is enforced in okfExportService, not by a
  // scope here). Import CREATES content, so it is destructive + content:create.
  export_okf: {
    identifier: "content.export_okf",
    requiredScope: "content:read",
    internalScopes: ["content:read"],
  },
  import_okf: {
    identifier: "content.import_okf",
    requiredScope: "content:create",
    internalScopes: ["content:create"],
    destructive: true,
  },
};

/**
 * The 5 MCP tools, projected into catalog manifest entries. Schemas/descriptions
 * come straight from `MCP_TOOLS`. The in-process handler is deliberately NOT bound
 * here: `ToolCatalog` resolves it lazily at dispatch time (via a dynamic import of
 * `lib/mcp/tool-handlers`), keyed by the MCP wire `name`. Binding the handler in
 * the manifest would pull the handler -> service -> auth -> `node:crypto` graph
 * into the boot-time sync's module graph, which Next.js also compiles for the Edge
 * runtime — breaking the production webpack build with a `node:crypto`
 * UnhandledSchemeError (PR #1032 follow-up). The manifest must stay pure metadata.
 * `surfaces` is `['mcp']` initially per the issue's migration plan (expand as
 * appropriate).
 */
const MCP_MANIFEST_ENTRIES: ToolManifestEntry[] = MCP_TOOLS.map(
  (tool: McpToolDefinition): ToolManifestEntry => {
    const mapping = MCP_TOOL_CATALOG_MAP[tool.name];
    if (!mapping) {
      // A new MCP tool was added without a catalog mapping. Fail loudly at module
      // load (and in tests) rather than silently dropping it from the catalog.
      throw new Error(
        `MCP tool "${tool.name}" has no catalog identifier mapping in ` +
          `lib/tools/catalog/manifest.ts (MCP_TOOL_CATALOG_MAP). Add one.`
      );
    }
    // Every code MCP tool has an in-process handler resolvable via
    // `catalog.dispatch()`, so each is also exposed on the `internal` surface for
    // the agentic Assistant Architect runtime (#926). The `mcp` base scope is the
    // right grant for an in-app agent calling the same handler.
    const surfaces: ToolSurface[] = ["mcp", "internal"];
    if (mapping.rest) surfaces.push("rest");

    // surfaceScopes: REST and internal each replace the base mcp scope on their
    // own surface. Merge both into one object (undefined keys are simply absent).
    const surfaceScopes: NonNullable<ToolManifestEntry["surfaceScopes"]> = {};
    if (mapping.rest) surfaceScopes.rest = mapping.rest.scopes;
    if (mapping.internalScopes) surfaceScopes.internal = mapping.internalScopes;

    return {
      identifier: mapping.identifier,
      version: mapping.version ?? "v1",
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      surfaces,
      requiredScopes: [mapping.requiredScope],
      agentCallable: true,
      ...(mapping.destructive ? { destructive: true } : {}),
      ...(Object.keys(surfaceScopes).length > 0 ? { surfaceScopes } : {}),
      ...(mapping.rest ? { rest: mapping.rest.binding } : {}),
    };
  }
);

/**
 * AI SDK tools exposed in chat / Nexus, projected from the single browser-safe
 * source of truth (`lib/tools/catalog/ai-sdk-tools.ts`). These are descriptor-only
 * catalog entries (no in-process MCP `handler`): the concrete tool implementations
 * are provider-native and built dynamically per request by
 * `lib/tools/provider-native-tools.ts`. Cataloging them gives the catalog a
 * complete `surfaces: ['ai_sdk']` view, a single place to scope-gate which built-in
 * tools a caller may use, AND the UI/model-gating metadata the Nexus tool selector
 * reads (so the catalog is the one source for identity, scope, and display).
 *
 * `show_chart` is universal (always enabled, no scope, no `ui`). The optional tools
 * carry `chat:write` so a caller without chat write cannot enable them. `name`
 * matches the wire/registry name the chat route already uses. (#924 follow-up.)
 */
const AI_SDK_MANIFEST_ENTRIES: ToolManifestEntry[] = AI_SDK_TOOLS.map((tool) => ({
  identifier: tool.identifier,
  version: "v1",
  name: tool.wireName,
  description: tool.description,
  inputSchema: { type: "object", properties: {} },
  surfaces: ["ai_sdk"],
  requiredScopes: tool.requiredScopes,
  agentCallable: true,
  ...(tool.ui
    ? {
        displayName: tool.ui.displayName,
        friendlyName: tool.friendlyName,
        category: tool.ui.category,
        requiredCapabilities: tool.ui.requiredCapabilities,
      }
    : {}),
}));

/**
 * Agent platform tools (Issue #926): image generation, bounded web fetch, and
 * document generation, exposed on the `internal` surface ONLY (not `mcp`/`rest`),
 * so the agentic Assistant Architect runtime can resolve + dispatch them but they
 * are not advertised to external MCP clients. Pure descriptors live in
 * `lib/agents/agent-tools/descriptors.ts`; their handlers are registered in
 * `lib/mcp/tool-handlers.ts` (spread from `AGENT_TOOL_HANDLERS`) and resolved
 * lazily at dispatch — keeping the S3/AI-SDK/format-lib graph out of this
 * Edge-compiled manifest module.
 */
const AGENT_TOOL_MANIFEST_ENTRIES: ToolManifestEntry[] = AGENT_TOOL_DESCRIPTORS.map(
  (descriptor): ToolManifestEntry => ({
    identifier: descriptor.identifier,
    version: "v1",
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    surfaces: ["internal"],
    requiredScopes: descriptor.requiredScopes,
    agentCallable: true,
  })
);

/**
 * The code-managed tool catalog. Boot-time sync reconciles `tool_catalog` to
 * this list; the runtime `ToolCatalog` merges it with DB-sourced entries.
 */
export const TOOL_MANIFEST: readonly ToolManifestEntry[] = [
  ...MCP_MANIFEST_ENTRIES,
  ...AI_SDK_MANIFEST_ENTRIES,
  ...AGENT_TOOL_MANIFEST_ENTRIES,
];

/**
 * Resolve a manifest entry by `domain.action` identifier, returning the highest
 * version when more than one exists. Versions are `v1`, `v2`, ...; non-`vN` values
 * fall back to a string compare so resolution stays deterministic.
 */
export function getManifestEntry(
  identifier: string
): ToolManifestEntry | undefined {
  const matches = TOOL_MANIFEST.filter((e) => e.identifier === identifier);
  if (matches.length === 0) return undefined;
  return matches.reduce((latest, entry) =>
    compareVersionsDesc(entry.version ?? "v1", latest.version ?? "v1") < 0
      ? entry
      : latest
  );
}
