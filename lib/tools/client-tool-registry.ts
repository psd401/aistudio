/**
 * Client-side safe tool registry functions
 * This file doesn't import server-side dependencies and can be used in browser.
 *
 * Issue #924 follow-up: the standalone `TOOL_REGISTRY` literal (a duplicate of the
 * one in `tool-registry.ts`) has been removed. The selectable chat tools now have
 * a single source — `lib/tools/catalog/ai-sdk-tools.ts` — which the catalog
 * manifest also ingests. The browser cannot call the server-side `ToolCatalog`
 * synchronously, so it reads that same source constant directly; there is no
 * second source of truth.
 */

import {
  filterToolsByCapabilities,
  getSelectableToolConfig,
  getSelectableToolConfigs,
  type ModelCapabilities,
  type ToolConfig,
} from '@/lib/tools/catalog/ai-sdk-tools'

// Re-export the shared tool types so existing client-side import sites
// (`@/lib/tools` / `@/lib/tools/client-tool-registry`) keep working.
export type { ModelCapabilities, ToolConfig }

/**
 * Get model capabilities from API endpoint (client-side safe)
 */
export async function getModelCapabilities(modelId: string): Promise<ModelCapabilities | null> {
  try {
    const url = `/api/models/${encodeURIComponent(modelId)}/capabilities`
    const response = await fetch(url)
    if (!response.ok) {
      return null
    }
    const capabilities = await response.json()
    return capabilities
  } catch {
    return null
  }
}

/**
 * Get available tools for a specific model based on its capabilities (client-side safe)
 */
export async function getAvailableToolsForModel(modelId: string): Promise<ToolConfig[]> {
  const capabilities = await getModelCapabilities(modelId)
  if (!capabilities) {
    return []
  }
  return filterToolsByCapabilities(capabilities)
}

/**
 * Check if a specific tool is available for a model
 */
export async function isToolAvailableForModel(
  modelId: string,
  toolName: string
): Promise<boolean> {
  const availableTools = await getAvailableToolsForModel(modelId)
  return availableTools.some(tool => tool.name === toolName)
}

/**
 * Get all registered tools (for UI rendering)
 */
export function getAllTools(): ToolConfig[] {
  return getSelectableToolConfigs()
}

/**
 * Get tool configuration by name
 */
export function getToolConfig(toolName: string): ToolConfig | undefined {
  return getSelectableToolConfig(toolName)
}
