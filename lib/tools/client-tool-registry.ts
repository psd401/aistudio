/**
 * Client-side safe tool registry functions
 * This file doesn't import server-side dependencies and can be used in browser
 */

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

export interface ToolConfig {
  name: string
  tool: unknown // Generic type for client-side usage
  requiredCapabilities: (keyof ModelCapabilities)[]
  displayName: string
  description: string
  category: 'search' | 'code' | 'analysis' | 'creative' | 'media'
}

/**
 * Registry of all available tools with their capability requirements
 * This is a static registry that doesn't require server-side dependencies
 */
const TOOL_REGISTRY: Record<string, ToolConfig> = {
  webSearch: {
    name: 'webSearch',
    tool: {}, // Placeholder for client-side usage
    requiredCapabilities: ['webSearch', 'grounding'],
    displayName: 'Web Search',
    description: 'Search the web for current information and facts',
    category: 'search'
  },
  codeInterpreter: {
    name: 'codeInterpreter',
    tool: {}, // Placeholder for client-side usage
    requiredCapabilities: ['codeInterpreter', 'codeExecution'],
    displayName: 'Code Interpreter',
    description: 'Execute code and perform data analysis',
    category: 'code'
  },
  generateImage: {
    name: 'generateImage',
    tool: {}, // Placeholder for client-side usage
    requiredCapabilities: ['imageGeneration'],
    displayName: 'Image Generation',
    description: 'Generate images from text descriptions using AI models like GPT-Image-1, DALL-E 3, and Imagen 4',
    category: 'media'
  },
  showChart: {
    name: 'showChart',
    tool: {}, // Placeholder for client-side usage
    requiredCapabilities: [], // Available for all models (renders on client)
    displayName: 'Chart Visualization',
    description: 'Display data as interactive charts and graphs (bar, line, area, scatter, pie)',
    category: 'analysis'
  }
}

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
  
  return Object.values(TOOL_REGISTRY).filter(toolConfig => {
    // Check if model has ANY of the required capabilities (OR logic)
    return toolConfig.requiredCapabilities.some(capability => 
      capabilities[capability] === true
    )
  })
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
  return Object.values(TOOL_REGISTRY)
}

/**
 * Get tool configuration by name
 */
export function getToolConfig(toolName: string): ToolConfig | undefined {
  return TOOL_REGISTRY[toolName]
}