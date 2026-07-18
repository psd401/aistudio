import { hasAnyCapability, hasCapability } from "@/lib/ai/capability-utils"
import { getSelectableToolConfig } from "@/lib/tools/catalog/ai-sdk-tools"
import type { ProviderMetadata } from "@/lib/db/types/jsonb"

export type ModelRouterFamily = "auto" | "openai" | "anthropic" | "google"
export type ModelRouterTier = "light" | "medium" | "high"
export type ConcreteModelFamily = Exclude<ModelRouterFamily, "auto">

export interface RoutableModel {
  id: number
  name: string
  provider: string
  modelId: string
  capabilities: string | null
  providerMetadata: ProviderMetadata | null
}

export interface ModelCapabilityRequirements {
  requiredTools?: string[]
  requiresFunctionCalling?: boolean
  requiresVision?: boolean
}

const EXECUTABLE_PROVIDERS = new Set(["openai", "google", "amazon-bedrock", "azure", "latimer"])

export function inferModelFamily(model: Pick<RoutableModel, "provider" | "modelId">): ConcreteModelFamily | null {
  const value = `${model.provider} ${model.modelId}`.toLowerCase()
  if (value.includes("google") || value.includes("gemini")) return "google"
  if (value.includes("anthropic") || value.includes("claude")) return "anthropic"
  if (value.includes("openai") || value.includes("gpt-") || value.includes("azure")) return "openai"
  return null
}

export function inferModelTier(model: RoutableModel): ModelRouterTier {
  const configured = model.providerMetadata?.modelRouterTier
    ?? model.providerMetadata?.nexusRouterTier
  if (configured === "light" || configured === "medium" || configured === "high") return configured
  const value = `${model.name} ${model.modelId}`.toLowerCase()
  if (/haiku|flash-lite|flash lite|nano|mini|luna|micro/.test(value)) return "light"
  if (/opus|fable|pro|sol|o3|o1|high/.test(value)) return "high"
  return "medium"
}

export function isExecutableTextModel(model: RoutableModel): boolean {
  if (!EXECUTABLE_PROVIDERS.has(model.provider.toLowerCase())) return false
  if (hasCapability(model.capabilities, "deepResearch")) return false
  if (!hasCapability(model.capabilities, "imageGeneration")) return true

  // Some multimodal chat models expose image-generation capabilities, but the
  // dedicated image endpoints cannot drive a text/tool loop. Exclude the known
  // specialist-only identifiers while allowing a chat model with that extra
  // capability to remain eligible.
  return !/dall-?e|gpt-image|imagen|flash-image|image-preview|image-generation/i.test(
    `${model.name} ${model.modelId}`
  )
}

/**
 * Mirror the provider adapters' current friendly-name support so routing never
 * selects a model whose adapter will silently filter an authored native tool.
 * Unknown tool names are treated as non-native (for example MCP/agent tools)
 * and remain governed by their own resolver plus function-calling support.
 */
export function modelSupportsProviderNativeTool(
  model: Pick<RoutableModel, "provider" | "modelId">,
  toolName: string
): boolean {
  const provider = model.provider.toLowerCase()
  if (toolName === "codeInterpreter") return provider === "openai"
  if (toolName === "webSearch") {
    if (provider === "google") return true
    if (provider !== "openai") return false
    return /(?:^|[./:_-])(gpt-5|o3|o4)/i.test(model.modelId)
  }
  // No streaming adapter currently materializes the selectable generateImage
  // tool. Image generation in Assistant Architect is the agent-platform
  // `images.generate` tool, which is intentionally not handled here.
  if (toolName === "generateImage") return false
  return true
}

export function compatibleRoutedToolNames(
  toolNamesByModel: string[][],
  enabledTools: string[]
): Set<string> {
  const compatibleModels = enabledTools.length === 0
    ? toolNamesByModel
    : toolNamesByModel.filter(toolNames => {
      const available = new Set(toolNames)
      return enabledTools.every(tool => available.has(tool))
    })
  return new Set(compatibleModels.flat())
}

export function modelMeetsCapabilityRequirements(
  model: RoutableModel,
  requirements: ModelCapabilityRequirements
): boolean {
  if (requirements.requiresFunctionCalling && model.providerMetadata?.supports_function_calling === false) {
    return false
  }
  if (requirements.requiresVision && model.providerMetadata?.supports_vision === false) {
    return false
  }

  for (const toolName of requirements.requiredTools ?? []) {
    const tool = getSelectableToolConfig(toolName)
    if (!tool || tool.requiredCapabilities.length === 0) continue
    if (!modelSupportsProviderNativeTool(model, toolName)) return false
    if (!hasAnyCapability(model.capabilities, tool.requiredCapabilities)) return false
  }
  return true
}

function firstEligibleModel(
  candidates: RoutableModel[],
  accessibleIds: Set<string>,
  eligible: (model: RoutableModel) => boolean
): RoutableModel | null {
  return candidates.find(model => accessibleIds.has(String(model.id)) && eligible(model)) ?? null
}

export function selectRoutedTextModel(args: {
  models: RoutableModel[]
  configuredCandidateIds: string[]
  accessibleIds: Set<string>
  family: ModelRouterFamily
  tier: ModelRouterTier
  fallbackModelId: string
  requirements?: ModelCapabilityRequirements
  additionalEligibility?: (model: RoutableModel) => boolean
}): { model: RoutableModel; fallbackUsed: boolean } | null {
  const eligible = (model: RoutableModel) => {
    if (!isExecutableTextModel(model)) return false
    if (args.family !== "auto" && inferModelFamily(model) !== args.family) return false
    if (!modelMeetsCapabilityRequirements(model, args.requirements ?? {})) return false
    return args.additionalEligibility?.(model) ?? true
  }

  const configured = args.configuredCandidateIds
    .map(id => args.models.find(model => model.modelId === id || String(model.id) === id))
    .filter((model): model is RoutableModel => model !== undefined)
  const configuredSelection = firstEligibleModel(configured, args.accessibleIds, eligible)
  if (configuredSelection) return { model: configuredSelection, fallbackUsed: false }

  const exactTier = firstEligibleModel(
    args.models.filter(model => inferModelTier(model) === args.tier),
    args.accessibleIds,
    eligible
  )
  if (exactTier) return { model: exactTier, fallbackUsed: args.configuredCandidateIds.length > 0 }

  const tierPreference = [args.tier, "medium", "light", "high"] as const
  const tierRank = new Map([...new Set(tierPreference)].map((tier, index) => [tier, index]))
  const adjacent = [...args.models].sort((left, right) =>
    (tierRank.get(inferModelTier(left)) ?? 99) - (tierRank.get(inferModelTier(right)) ?? 99)
  )
  const adjacentSelection = firstEligibleModel(adjacent, args.accessibleIds, eligible)
  if (adjacentSelection) return { model: adjacentSelection, fallbackUsed: true }

  const fallback = args.models.find(model =>
    model.modelId === args.fallbackModelId || String(model.id) === args.fallbackModelId
  )
  if (fallback && args.accessibleIds.has(String(fallback.id)) && eligible(fallback)) {
    return { model: fallback, fallbackUsed: true }
  }
  return null
}
