/**
 * AI SDK chat tools — single source of truth (browser-safe).
 *
 * Issue #924 follow-up. The AI SDK chat tools were previously declared in THREE
 * places: the catalog manifest (`lib/tools/catalog/manifest.ts`), the server
 * registry (`lib/tools/tool-registry.ts`), and the client registry
 * (`lib/tools/client-tool-registry.ts`). This module is now the ONE place they
 * are defined. Everything else derives from it:
 *
 *   - the catalog manifest projects these into `ToolManifestEntry` rows, so the
 *     runtime `ToolCatalog` ingests them as `source='code'`, `surfaces=['ai_sdk']`
 *     (the catalog is the runtime single source of truth);
 *   - the server registry (`tool-registry.ts`) reads them back from the live
 *     `ToolCatalog` on its async path and from this constant on its sync paths;
 *   - the client registry (`client-tool-registry.ts`) — which cannot call the
 *     server-side `ToolCatalog` synchronously in a browser — reads this constant
 *     directly. It is the same data the catalog ingests, so there is no second
 *     source.
 *
 * Adding a chat tool = add one entry to {@link AI_SDK_TOOLS}. No other file edit.
 *
 * Browser-safe: this module must NOT import server-only code (DB, `node:*`,
 * provider SDKs). The client registry and Nexus UI import it.
 */

/** Model-capability flags parsed from a model's `capabilities` field. */
export interface ModelCapabilities {
  webSearch: boolean
  codeInterpreter: boolean
  codeExecution: boolean
  grounding: boolean
  workspaceTools: boolean
  canvas: boolean
  artifacts: boolean
  thinking: boolean
  reasoning: boolean
  computerUse: boolean
  responsesAPI: boolean
  promptCaching: boolean
  contextCaching: boolean
  imageGeneration: boolean
}

/** UI grouping for a selectable chat tool. */
export type ToolCategory = 'search' | 'code' | 'analysis' | 'creative' | 'media'

/**
 * UI/selection view of a chat tool, consumed by the Nexus tool selectors and
 * status indicator. `name` is the friendly key (e.g. `webSearch`) the UI and the
 * `enabledTools` list use. The executable tool object is built per-request by
 * `provider-native-tools.ts`, never from here, so it is intentionally omitted.
 */
export interface ToolConfig {
  name: string
  requiredCapabilities: (keyof ModelCapabilities)[]
  displayName: string
  description: string
  category: ToolCategory
}

/**
 * A single AI SDK chat tool definition — the canonical record. `ui` is present
 * only for user-selectable tools; universal/always-on tools (e.g. `show_chart`)
 * omit it and never appear in the selection registry.
 */
export interface AiSdkToolDef {
  /** Catalog `domain.action` identifier (e.g. `chat.web_search`). */
  identifier: string
  /**
   * Immutable catalog contract version. Bump whenever the projected schema
   * changes after release.
   */
  version?: `v${number}`
  /** MCP/provider wire name — the catalog `name` (e.g. `web_search_preview`). */
  wireName: string
  /** Friendly key used by the UI registry + `enabledTools` (e.g. `webSearch`). */
  friendlyName: string
  /** Model + human readable description (used by the catalog and the UI). */
  description: string
  /** API scopes a caller must hold to enable the tool. */
  requiredScopes: string[]
  /** Present only for user-selectable tools (excludes always-on universals). */
  ui?: {
    displayName: string
    category: ToolCategory
    /** Model-capability keys; the tool shows for a model with ANY of these. */
    requiredCapabilities: (keyof ModelCapabilities)[]
  }
}

/**
 * The canonical AI SDK chat tool list. Order is the UI display order.
 * `show_chart` is universal (always enabled, no scope, no `ui`) and so is not a
 * selectable registry tool — see `provider-native-tools.ts` `createUniversalTools`.
 */
export const AI_SDK_TOOLS: readonly AiSdkToolDef[] = [
  {
    identifier: 'chat.show_chart',
    version: 'v2',
    wireName: 'show_chart',
    friendlyName: 'showChart',
    description:
      'Render a chart (bar, line, pie, etc.) from structured data on the client.',
    requiredScopes: [],
  },
  {
    identifier: 'chat.web_search',
    version: 'v2',
    wireName: 'web_search_preview',
    friendlyName: 'webSearch',
    description: 'Search the web for current information and facts.',
    requiredScopes: ['chat:write'],
    ui: {
      displayName: 'Web Search',
      category: 'search',
      requiredCapabilities: ['webSearch', 'grounding'],
    },
  },
  {
    identifier: 'chat.code_interpreter',
    version: 'v2',
    wireName: 'code_interpreter',
    friendlyName: 'codeInterpreter',
    description: 'Execute code and perform data analysis.',
    requiredScopes: ['chat:write'],
    ui: {
      displayName: 'Code Interpreter',
      category: 'code',
      requiredCapabilities: ['codeInterpreter', 'codeExecution'],
    },
  },
  {
    identifier: 'chat.generate_image',
    version: 'v2',
    wireName: 'generateImage',
    friendlyName: 'generateImage',
    description:
      'Generate images from text descriptions using AI models like GPT-Image-1, DALL-E 3, and Imagen 4.',
    requiredScopes: ['chat:write'],
    ui: {
      displayName: 'Image Generation',
      category: 'media',
      requiredCapabilities: ['imageGeneration'],
    },
  },
]

/** A canonical def known to carry UI metadata (selectable tools only). */
type AiSdkToolDefWithUi = AiSdkToolDef & { ui: NonNullable<AiSdkToolDef['ui']> }

/** Map a canonical selectable def to the UI `ToolConfig`. */
function toToolConfig(def: AiSdkToolDefWithUi): ToolConfig {
  const { ui } = def
  return {
    name: def.friendlyName,
    requiredCapabilities: ui.requiredCapabilities,
    displayName: ui.displayName,
    description: def.description,
    category: ui.category,
  }
}

/**
 * The user-selectable chat tools as `ToolConfig[]` (excludes universals like
 * `show_chart`). This is the single derivation both registries use for their
 * full-list / lookup needs.
 */
export function getSelectableToolConfigs(): ToolConfig[] {
  return AI_SDK_TOOLS.filter(
    (d): d is AiSdkToolDefWithUi => d.ui !== undefined
  ).map(toToolConfig)
}

/** Look up a selectable tool's `ToolConfig` by its friendly name. */
export function getSelectableToolConfig(name: string): ToolConfig | undefined {
  return getSelectableToolConfigs().find((t) => t.name === name)
}

/**
 * Filter any `ToolConfig[]` down to those a model supports. A tool shows when the
 * model has ANY of its `requiredCapabilities` (OR logic); tools with no required
 * capabilities are universal. This is the single capability-gate implementation —
 * both the sync (`filterToolsByCapabilities`) and catalog-backed
 * (`tool-registry.ts`) paths call it so the two cannot drift.
 */
export function filterToolConfigsByCapabilities(
  tools: ToolConfig[],
  capabilities: ModelCapabilities
): ToolConfig[] {
  return tools.filter((toolConfig) => {
    if (toolConfig.requiredCapabilities.length === 0) return true
    return toolConfig.requiredCapabilities.some(
      (capability) => capabilities[capability] === true
    )
  })
}

/**
 * Filter selectable tools down to those a model supports, mirroring the prior
 * registry behavior. Delegates to {@link filterToolConfigsByCapabilities}.
 */
export function filterToolsByCapabilities(
  capabilities: ModelCapabilities
): ToolConfig[] {
  return filterToolConfigsByCapabilities(getSelectableToolConfigs(), capabilities)
}

/** The valid `ToolCategory` values, for runtime validation of DB-sourced data. */
const VALID_TOOL_CATEGORIES: ReadonlySet<string> = new Set<ToolCategory>([
  'search',
  'code',
  'analysis',
  'creative',
  'media',
])

/**
 * Coerce an arbitrary (possibly DB-sourced) category string to a valid
 * `ToolCategory`. Unknown/absent values fall back to `'analysis'` — the neutral
 * "general purpose" bucket — rather than passing an invalid literal through a
 * cast. Returning a known-good value keeps the Nexus selector grouping stable.
 */
export function toToolCategory(value: string | undefined): ToolCategory {
  return value && VALID_TOOL_CATEGORIES.has(value)
    ? (value as ToolCategory)
    : 'analysis'
}
