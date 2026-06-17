import type { ToolSet } from 'ai'
import { getAIModelByModelId } from '@/lib/db/drizzle'
import { parseCapabilities, type CapabilityKey } from '@/lib/ai/capability-utils'
import { toolCatalogInstance } from '@/lib/tools/catalog/catalog'
import { getFriendlyToolName } from '@/lib/tools/tool-name-mapping'
import {
  getSelectableToolConfigs,
  getSelectableToolConfig,
  type ModelCapabilities,
  type ToolCategory,
  type ToolConfig,
} from '@/lib/tools/catalog/ai-sdk-tools'

// Note: Logger removed to avoid browser compatibility issues when imported client-side

// Re-export the shared tool types so existing server-side import sites
// (`@/lib/tools/tool-registry`) keep working after the single-source refactor.
export type { ModelCapabilities, ToolConfig }

/**
 * Server-side AI SDK tool registry.
 *
 * Issue #924 follow-up: the standalone `TOOL_REGISTRY` literal that used to live
 * here (and a duplicate in `client-tool-registry.ts`) has been removed. The chat
 * tools now have a single source — `lib/tools/catalog/ai-sdk-tools.ts` — which the
 * catalog manifest ingests. This module derives the selectable tool list from the
 * live `ToolCatalog` (async paths) and from the shared source (sync paths); both
 * resolve to the same data because the catalog is built from that source.
 */

/**
 * Get model capabilities from database (SERVER-SIDE ONLY)
 *
 * Reads from the unified `capabilities` text/JSON array field.
 * Part of Issue #594 - Migrate from nexus_capabilities JSONB to capabilities array.
 */
export async function getModelCapabilities(modelId: string): Promise<ModelCapabilities | null> {
  // Server-side only guard
  if (typeof window !== 'undefined') {
    throw new TypeError('getModelCapabilities can only be called server-side. Use client-tool-registry for client-side usage.')
  }
  try {
    // Validate modelId format before database query
    // eslint-disable-next-line no-useless-escape
    if (!modelId || typeof modelId !== 'string' || !/^[\w.\-]+$/.test(modelId)) {
      return null
    }

    const model = await getAIModelByModelId(modelId)

    if (!model || !model.active) {
      return null
    }

    // Parse capabilities from the unified capabilities field (text/JSON array)
    const capabilitySet = parseCapabilities(model.capabilities)

    // Helper function to check if a capability exists in the set
    const has = (key: CapabilityKey): boolean => capabilitySet.has(key)

    // Map to ModelCapabilities interface
    return {
      webSearch: has('webSearch'),
      codeInterpreter: has('codeInterpreter'),
      codeExecution: has('codeExecution'),
      grounding: has('grounding'),
      workspaceTools: has('workspaceTools'),
      canvas: has('canvas'),
      artifacts: has('artifacts'),
      thinking: has('thinking'),
      reasoning: has('reasoning'),
      computerUse: has('computerUse'),
      responsesAPI: has('responsesAPI'),
      promptCaching: has('promptCaching'),
      contextCaching: has('contextCaching'),
      imageGeneration: has('imageGeneration')
    }
  } catch {
    // Return null on error - error details available through proper logging
    // in calling functions (server actions, API routes) that have access to logger
    return null
  }
}

/**
 * Project the catalog's selectable `ai_sdk` tools into `ToolConfig[]`.
 *
 * Reads the live `ToolCatalog` (so future assistant/skill-derived ai_sdk tools
 * with display metadata are included automatically), keeping the catalog the
 * single source of truth. Selectable tools are those that carry a `displayName`
 * (universal/always-on tools such as `show_chart` omit it). The catalog `name`
 * is the wire name; the UI uses the friendly name.
 */
async function getSelectableToolConfigsFromCatalog(): Promise<ToolConfig[]> {
  const entries = await toolCatalogInstance.list({ surface: 'ai_sdk' })
  return entries
    .filter((e) => e.displayName)
    .map((e) => ({
      name: getFriendlyToolName(e.name) ?? e.name,
      tool: {},
      requiredCapabilities: (e.requiredCapabilities ?? []) as (keyof ModelCapabilities)[],
      displayName: e.displayName as string,
      description: e.description,
      category: (e.category ?? 'analysis') as ToolCategory,
    }))
}

/**
 * Get available tools for a specific model based on its capabilities (SERVER-SIDE ONLY)
 */
export async function getAvailableToolsForModel(modelId: string): Promise<ToolConfig[]> {
  // Server-side only guard
  if (typeof window !== 'undefined') {
    throw new TypeError('getAvailableToolsForModel can only be called server-side. Use client-tool-registry for client-side usage.')
  }
  const capabilities = await getModelCapabilities(modelId)
  if (!capabilities) {
    return []
  }

  const tools = await getSelectableToolConfigsFromCatalog()
  return tools.filter(toolConfig => {
    // Tools with no required capabilities are universal (available for all models)
    if (toolConfig.requiredCapabilities.length === 0) {
      return true
    }
    // Check if model has ANY of the required capabilities (OR logic)
    return toolConfig.requiredCapabilities.some(capability =>
      capabilities[capability] === true
    )
  })
}

/**
 * Build tools object for AI SDK based on enabled tools and model capabilities
 * Now uses provider adapter's native tool implementations
 */
export async function buildToolsForRequest(
  modelId: string,
  enabledTools: string[] = [],
  provider?: string
): Promise<ToolSet> {
  // If no provider specified, return empty
  if (!provider) {
    return {};
  }

  // Use provider adapter to build tools (new pattern)
  try {
    const { getProviderAdapter } = await import('@/lib/streaming/provider-adapters');
    const adapter = await getProviderAdapter(provider);

    // Create model to initialize adapter's client
    await adapter.createModel(modelId);

    // Create tools from adapter
    return await adapter.createTools(enabledTools);
  } catch (error) {
    const log = await import('@/lib/logger').then(m => m.createLogger({ module: 'tool-registry' }));
    log.error('Failed to build tools via adapter', {
      error: error instanceof Error ? error.message : String(error),
      provider,
      modelId,
      enabledTools
    });
    return {};
  }
}

/**
 * Check if a specific tool is available for a model (SERVER-SIDE ONLY)
 */
export async function isToolAvailableForModel(
  modelId: string,
  toolName: string
): Promise<boolean> {
  // Server-side only guard
  if (typeof window !== 'undefined') {
    throw new TypeError('isToolAvailableForModel can only be called server-side. Use client-tool-registry for client-side usage.')
  }
  const availableTools = await getAvailableToolsForModel(modelId)
  return availableTools.some(tool => tool.name === toolName)
}

/**
 * Get all registered selectable tools (for UI rendering / validation).
 * Sync derivation from the shared single source (same data the catalog ingests).
 */
export function getAllTools(): ToolConfig[] {
  return getSelectableToolConfigs()
}

/**
 * Get tool configuration by friendly name. Sync derivation from the shared source.
 */
export function getToolConfig(toolName: string): ToolConfig | undefined {
  return getSelectableToolConfig(toolName)
}
