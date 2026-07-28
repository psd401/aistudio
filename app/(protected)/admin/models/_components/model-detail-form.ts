import { capabilitiesToNexusCapabilities } from "@/lib/ai/capability-utils"
import type { NexusCapabilities, ProviderMetadata } from "@/lib/db/types/jsonb"
import type { SelectAiModel } from "@/types/db-types"

export interface ModelFormData {
  id?: number
  name: string
  provider: string
  modelId: string
  description: string
  capabilities: string
  capabilitiesList: string[]
  maxTokens: number
  active: boolean
  nexusEnabled: boolean
  architectEnabled: boolean
  inputCostPer1kTokens: string | null
  outputCostPer1kTokens: string | null
  cachedInputCostPer1kTokens: string | null
  cacheWriteCostPer1kTokens: string | null
  averageLatencyMs: number | null
  maxConcurrency: number | null
  supportsBatching: boolean
  nexusCapabilities: NexusCapabilities
  providerMetadata: ProviderMetadata
}

export type CostField =
  | "inputCostPer1kTokens"
  | "outputCostPer1kTokens"
  | "cachedInputCostPer1kTokens"
  | "cacheWriteCostPer1kTokens"

export type CostErrors = Partial<Record<CostField, string>>

export type UpdateModelField = <K extends keyof ModelFormData>(
  field: K,
  value: ModelFormData[K]
) => void

export const emptyFormData: ModelFormData = {
  name: "",
  provider: "",
  modelId: "",
  description: "",
  capabilities: "",
  capabilitiesList: [],
  maxTokens: 4096,
  active: true,
  nexusEnabled: true,
  architectEnabled: true,
  inputCostPer1kTokens: null,
  outputCostPer1kTokens: null,
  cachedInputCostPer1kTokens: null,
  cacheWriteCostPer1kTokens: null,
  averageLatencyMs: null,
  maxConcurrency: null,
  supportsBatching: false,
  nexusCapabilities: capabilitiesToNexusCapabilities(""),
  providerMetadata: {},
}

export function parseCapabilities(capabilities: unknown): string[] {
  if (!capabilities) return []
  if (Array.isArray(capabilities)) {
    return capabilities.filter(
      (capability): capability is string => typeof capability === "string"
    )
  }
  if (typeof capabilities !== "string") return []

  try {
    const parsed = JSON.parse(capabilities) as unknown
    return Array.isArray(parsed)
      ? parsed.filter(
          (capability): capability is string => typeof capability === "string"
        )
      : []
  } catch {
    return capabilities.trim() ? [capabilities] : []
  }
}

export function parseProviderMetadata(metadata: unknown): ProviderMetadata {
  if (!metadata) return {}
  if (typeof metadata !== "string") return metadata as ProviderMetadata

  try {
    const parsed = JSON.parse(metadata) as unknown
    return parsed && typeof parsed === "object"
      ? (parsed as ProviderMetadata)
      : {}
  } catch {
    return {}
  }
}

export function modelToFormData(model: SelectAiModel): ModelFormData {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider || "",
    modelId: model.modelId,
    description: model.description || "",
    capabilities: model.capabilities || "",
    capabilitiesList: parseCapabilities(model.capabilities),
    maxTokens: model.maxTokens || 4096,
    active: model.active,
    nexusEnabled: model.nexusEnabled ?? true,
    architectEnabled: model.architectEnabled ?? true,
    inputCostPer1kTokens: model.inputCostPer1kTokens || null,
    outputCostPer1kTokens: model.outputCostPer1kTokens || null,
    cachedInputCostPer1kTokens: model.cachedInputCostPer1kTokens || null,
    cacheWriteCostPer1kTokens: model.cacheWriteCostPer1kTokens || null,
    averageLatencyMs: model.averageLatencyMs || null,
    maxConcurrency: model.maxConcurrency || null,
    supportsBatching: model.supportsBatching || false,
    nexusCapabilities: capabilitiesToNexusCapabilities(model.capabilities),
    providerMetadata: parseProviderMetadata(model.providerMetadata),
  }
}
