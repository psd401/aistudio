import type { ToolSet } from 'ai'
import { getAIModelByModelId } from '@/lib/db/drizzle'
import { parseCapabilities, type CapabilityKey } from '@/lib/ai/capability-utils'

// Note: Logger removed to avoid browser compatibility issues when imported client-side

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

// Define a basic tool type to avoid 'any'
export interface ToolDefinition {
  description: string
  parameters: {
    _input: unknown
    _output: unknown
  }
  execute?: (params: unknown) => Promise<unknown>
}

// Placeholder tool definition for provider-native tools
const createPlaceholderTool = (description: string): ToolDefinition => ({
  description,
  parameters: {
    _input: undefined,
    _output: undefined
  }
})

export interface ToolConfig {
  name: string
  tool: ToolDefinition
  requiredCapabilities: (keyof ModelCapabilities)[]
  displayName: string
  description: string
  category: 'search' | 'code' | 'analysis' | 'creative' | 'media'
}

/**
 * Registry of tools that require manual selection
 * Universal tools (like showChart) are always enabled - see provider-native-tools.ts
 */
const TOOL_REGISTRY: Record<string, ToolConfig> = {
  webSearch: {
    name: 'webSearch',
    tool: createPlaceholderTool('Search the web for current information and facts'),
    requiredCapabilities: ['webSearch', 'grounding'],
    displayName: 'Web Search',
    description: 'Search the web for current information and facts',
    category: 'search'
  },
  codeInterpreter: {
    name: 'codeInterpreter',
    tool: createPlaceholderTool('Execute code and perform data analysis'),
    requiredCapabilities: ['codeInterpreter', 'codeExecution'],
    displayName: 'Code Interpreter',
    description: 'Execute code and perform data analysis',
    category: 'code'
  },
  generateImage: {
    name: 'generateImage',
    tool: createPlaceholderTool('Generate images from text descriptions using AI'),
    requiredCapabilities: ['imageGeneration'],
    displayName: 'Image Generation',
    description: 'Generate images from text descriptions using AI models like GPT-Image-1, DALL-E 3, and Imagen 4',
    category: 'media'
  }
  // Note: showChart is a universal tool that's always enabled - see provider-native-tools.ts
}

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

  return Object.values(TOOL_REGISTRY).filter(toolConfig => {
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
 * Get all registered tools (for UI rendering)
 */
export function getAllTools(): ToolConfig[] {
  return Object.values(TOOL_REGISTRY)
}

/**
 * Get tool configuration by name
 */
export function getToolConfig(toolName: string): ToolConfig | undefined {
  return TOOL_REGISTRY[toolName]
}

// Note: ToolConfig interface is already exported above, ModelCapabilities already exported above