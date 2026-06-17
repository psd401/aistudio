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
import { AI_SDK_TOOLS } from "./ai-sdk-tools";
import type { ToolManifestEntry } from "./types";
import { compareVersionsDesc } from "./utils";

/** Source value applied to every manifest-managed catalog row. */
export const MANIFEST_TOOL_SOURCE = "code" as const;

/**
 * Map each existing MCP wire tool to its canonical catalog identifier + scope.
 * Keeps the schema/description single-sourced from `MCP_TOOLS` while assigning
 * the new `domain.action` identifier and the required scope.
 */
const MCP_TOOL_CATALOG_MAP: Record<
  string,
  { identifier: string; requiredScope: string }
> = {
  search_decisions: {
    identifier: "decisions.search",
    requiredScope: "mcp:search_decisions",
  },
  capture_decision: {
    identifier: "decisions.capture",
    requiredScope: "mcp:capture_decision",
  },
  execute_assistant: {
    identifier: "assistants.execute",
    requiredScope: "mcp:execute_assistant",
  },
  list_assistants: {
    identifier: "assistants.list",
    requiredScope: "mcp:list_assistants",
  },
  get_decision_graph: {
    identifier: "decisions.graph_get",
    requiredScope: "mcp:get_decision_graph",
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
    return {
      identifier: mapping.identifier,
      version: "v1",
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      surfaces: ["mcp"],
      requiredScopes: [mapping.requiredScope],
      agentCallable: true,
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
        category: tool.ui.category,
        requiredCapabilities: tool.ui.requiredCapabilities,
      }
    : {}),
}));

/**
 * The code-managed tool catalog. Boot-time sync reconciles `tool_catalog` to
 * this list; the runtime `ToolCatalog` merges it with DB-sourced entries.
 */
export const TOOL_MANIFEST: readonly ToolManifestEntry[] = [
  ...MCP_MANIFEST_ENTRIES,
  ...AI_SDK_MANIFEST_ENTRIES,
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
