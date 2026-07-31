import { getSettings } from "@/lib/settings-manager"
import { createLogger } from "@/lib/logger"
import { getAIModelById, getArchitectEnabledModels } from "@/lib/db/drizzle"
import { filterAccessibleResourceIds } from "@/lib/db/drizzle/resource-access"
import {
  inferModelFamily,
  inferModelTier,
  selectRoutedTextModel,
  type ModelCapabilityRequirements,
  type ModelRouterFamily,
  type RoutableModel,
} from "@/lib/ai/model-router/core"
import { classifyNexusRequest } from "@/lib/nexus/model-router/classifier"
import {
  NEXUS_ROUTER_CONFIG_KEY,
} from "@/lib/nexus/model-router/config"
import {
  nexusRouterConfigSchema,
  nexusRouterRuntimeModeSchema,
  type NexusClassifierDecision,
  type NexusRouterConfig,
  type NexusRouterRuntimeMode,
} from "@/lib/nexus/model-router/types"
import type {
  AssistantModelFamily,
  AssistantModelRoutingMode,
} from "@/lib/db/schema/tables/assistant-architects"
import { ASSISTANT_ARCHITECT_ROUTER_MODE_KEY } from "./model-router-config"
import {
  AGENTIC_MODEL_CONFIGURATION_ERROR,
  isAgenticModelReady,
} from "@/lib/agents/model-readiness"

export { ASSISTANT_ARCHITECT_ROUTER_MODE_KEY } from "./model-router-config"

const log = createLogger({ module: "assistant-architect-model-router" })

type AIModelRow = NonNullable<Awaited<ReturnType<typeof getAIModelById>>>

export interface AssistantArchitectRoutingMetadata {
  version: string
  runtimeMode: NexusRouterRuntimeMode
  routingMode: AssistantModelRoutingMode
  requestedFamily: ModelRouterFamily
  selectedFamily: Exclude<ModelRouterFamily, "auto"> | "other"
  intent: NexusClassifierDecision["intent"]
  tier: NexusClassifierDecision["tier"]
  confidence: number
  reasonCodes: string[]
  decisionSource: NexusClassifierDecision["source"]
  selectedModelDbId: number
  selectedModelId: string
  selectedProvider: string
  proposedModelId?: string
  fallbackUsed: boolean
  requiredTools: string[]
  requiresFunctionCalling: boolean
  requiresVision: boolean
}

export interface AssistantArchitectModelRoute {
  modelDbId: number
  modelId: string
  provider: string
  model: AIModelRow
  metadata: AssistantArchitectRoutingMetadata
}

async function loadRouterConfiguration(): Promise<{
  config: NexusRouterConfig
  mode: NexusRouterRuntimeMode
}> {
  const settings = await getSettings([
    NEXUS_ROUTER_CONFIG_KEY,
    ASSISTANT_ARCHITECT_ROUTER_MODE_KEY,
  ])
  const modeResult = nexusRouterRuntimeModeSchema.safeParse(
    settings[ASSISTANT_ARCHITECT_ROUTER_MODE_KEY] ?? "active"
  )
  let mode: NexusRouterRuntimeMode = modeResult.success ? modeResult.data : "shadow"
  if (!modeResult.success) {
    log.warn("Invalid Assistant Architect router mode; failing safely to shadow")
  }

  const rawConfig = settings[NEXUS_ROUTER_CONFIG_KEY]
  if (!rawConfig) return { config: nexusRouterConfigSchema.parse({}), mode }
  try {
    const parsed = nexusRouterConfigSchema.safeParse(JSON.parse(rawConfig) as unknown)
    if (parsed.success) return { config: parsed.data, mode }
    log.warn("Invalid shared model router configuration for Assistant Architect", {
      issueCount: parsed.error.issues.length,
    })
  } catch (error) {
    log.warn("Could not parse shared model router configuration for Assistant Architect", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  if (mode === "active") mode = "shadow"
  return { config: nexusRouterConfigSchema.parse({}), mode }
}

function configuredCandidates(
  config: NexusRouterConfig,
  family: ModelRouterFamily,
  decision: NexusClassifierDecision
): string[] {
  if (decision.intent === "instruction" && family === "auto") {
    return config.specialists.instructionModels
  }
  return family === "auto"
    ? config.auto[decision.tier]
    : config.families[family][decision.tier]
}

function routingFamily(
  mode: AssistantModelRoutingMode,
  family: AssistantModelFamily | null | undefined
): ModelRouterFamily {
  return mode === "advanced" && family ? family : "auto"
}

async function assertModelAccess(userId: number, modelId: number): Promise<void> {
  const accessible = await filterAccessibleResourceIds(userId, "model", [modelId])
  if (!accessible.has(String(modelId))) {
    throw new Error("You do not have access to the pinned fallback model for this assistant")
  }
}

function pinnedMetadata(
  model: AIModelRow,
  routingMode: AssistantModelRoutingMode,
  runtimeMode: NexusRouterRuntimeMode,
  requirements: ModelCapabilityRequirements,
  requestedFamily?: AssistantModelFamily | null
): AssistantArchitectRoutingMetadata {
  return {
    version: "legacy",
    runtimeMode,
    routingMode,
    requestedFamily: routingFamily(routingMode, requestedFamily),
    selectedFamily: inferModelFamily(model) ?? "other",
    intent: "general",
    tier: inferModelTier(model as RoutableModel),
    confidence: 1,
    reasonCodes: [routingMode === "legacy" ? "legacy_pinned_model" : "router_off"],
    decisionSource: "fallback",
    selectedModelDbId: model.id,
    selectedModelId: model.modelId,
    selectedProvider: model.provider,
    fallbackUsed: false,
    requiredTools: requirements.requiredTools ?? [],
    requiresFunctionCalling: requirements.requiresFunctionCalling ?? false,
    requiresVision: requirements.requiresVision ?? false,
  }
}

async function pinnedRoute(
  fallback: AIModelRow & { modelId: string; provider: string },
  args: {
    userId: number
    routingMode: AssistantModelRoutingMode
    requestedFamily?: AssistantModelFamily | null
  },
  runtimeMode: NexusRouterRuntimeMode,
  requirements: ModelCapabilityRequirements
): Promise<AssistantArchitectModelRoute> {
  await assertModelAccess(args.userId, fallback.id)
  return {
    modelDbId: fallback.id,
    modelId: fallback.modelId,
    provider: fallback.provider,
    model: fallback,
    metadata: pinnedMetadata(
      fallback,
      args.routingMode,
      runtimeMode,
      requirements,
      args.requestedFamily
    ),
  }
}

interface RoutingSelection {
  selected: RoutableModel
  fallbackUsed: boolean
  proposedModelId?: string
}

async function resolveRoutingSelection(options: {
  routed: ReturnType<typeof selectRoutedTextModel>
  mode: NexusRouterRuntimeMode
  fallback: AIModelRow & { modelId: string; provider: string }
  userId: number
  family: ModelRouterFamily
}): Promise<RoutingSelection> {
  const { routed, mode, fallback, userId, family } = options
  if (!routed && mode !== "shadow") {
    const target =
      family === "auto" ? "the required capabilities" : `the ${family} family`
    throw new Error(
      `No accessible Assistant Architect model is available for ${target}`
    )
  }
  if (mode === "shadow") {
    await assertModelAccess(userId, fallback.id)
    return {
      selected: fallback,
      fallbackUsed: Boolean(
        routed?.fallbackUsed || routed?.model.id !== fallback.id
      ),
      proposedModelId: routed?.model.modelId,
    }
  }
  return {
    selected: routed?.model ?? fallback,
    fallbackUsed: routed?.fallbackUsed ?? true,
  }
}

function activeRoutingMetadata(options: {
  config: NexusRouterConfig
  mode: NexusRouterRuntimeMode
  routingMode: AssistantModelRoutingMode
  family: ModelRouterFamily
  decision: NexusClassifierDecision
  selected: RoutableModel
  proposedModelId?: string
  fallbackUsed: boolean
  requirements: ModelCapabilityRequirements
}): AssistantArchitectRoutingMetadata {
  const {
    config,
    mode,
    routingMode,
    family,
    decision,
    selected,
    proposedModelId,
    fallbackUsed,
    requirements,
  } = options
  return {
    version: config.version,
    runtimeMode: mode,
    routingMode,
    requestedFamily: family,
    selectedFamily: inferModelFamily(selected) ?? "other",
    intent: decision.intent,
    tier: decision.tier,
    confidence: decision.confidence,
    reasonCodes: decision.reasonCodes,
    decisionSource: decision.source,
    selectedModelDbId: selected.id,
    selectedModelId: selected.modelId,
    selectedProvider: selected.provider,
    proposedModelId,
    fallbackUsed,
    requiredTools: requirements.requiredTools ?? [],
    requiresFunctionCalling: requirements.requiresFunctionCalling ?? false,
    requiresVision: requirements.requiresVision ?? false,
  }
}

// eslint-disable-next-line complexity -- Fail-closed agentic admission is layered onto legacy, shadow, and active routing modes.
export async function routeAssistantArchitectModel(args: {
  text: string
  userId: number
  fallbackModelDbId: number
  routingMode: AssistantModelRoutingMode
  requestedFamily?: AssistantModelFamily | null
  requirements?: ModelCapabilityRequirements
  agenticRequired?: boolean
}): Promise<AssistantArchitectModelRoute> {
  const fallback = await getAIModelById(args.fallbackModelDbId)
  if (!fallback?.modelId || !fallback.provider) {
    throw new Error("The Assistant Architect fallback model is unavailable")
  }
  const requirements = args.requirements ?? {}

  if (args.routingMode === "legacy") {
    if (args.agenticRequired && !isAgenticModelReady(fallback)) {
      throw new Error(AGENTIC_MODEL_CONFIGURATION_ERROR)
    }
    return pinnedRoute(fallback, args, "off", requirements)
  }

  const { config, mode } = await loadRouterConfiguration()
  if (mode === "off") {
    if (args.agenticRequired && !isAgenticModelReady(fallback)) {
      throw new Error(AGENTIC_MODEL_CONFIGURATION_ERROR)
    }
    return pinnedRoute(fallback, args, mode, requirements)
  }
  if (
    mode === "shadow" &&
    args.agenticRequired &&
    !isAgenticModelReady(fallback)
  ) {
    throw new Error(AGENTIC_MODEL_CONFIGURATION_ERROR)
  }

  const architectModels = await getArchitectEnabledModels()
  const models = args.agenticRequired
    ? architectModels.filter(isAgenticModelReady)
    : architectModels
  if (args.agenticRequired && models.length === 0) {
    throw new Error(AGENTIC_MODEL_CONFIGURATION_ERROR)
  }
  const accessibleIds = new Set(await filterAccessibleResourceIds(
    args.userId,
    "model",
    models.map(model => model.id)
  ))
  const decision = await classifyNexusRequest(args.text, config)
  const family = routingFamily(args.routingMode, args.requestedFamily)
  const routed = selectRoutedTextModel({
    models,
    configuredCandidateIds: configuredCandidates(config, family, decision),
    accessibleIds,
    family,
    tier: decision.tier,
    fallbackModelId: String(fallback.id),
    requirements,
    // Image and PSD-data are capabilities/tools on this surface, not direct
    // specialist model or connector selection policies. Instruction specialists
    // are preferred through configuredCandidateIds, while another eligible model
    // can still provide a resilient fallback when Gemini is unavailable.
  })
  const { selected, fallbackUsed, proposedModelId } =
    await resolveRoutingSelection({
      routed,
      mode,
      fallback,
      userId: args.userId,
      family,
    })
  const selectedRow = selected.id === fallback.id
    ? fallback
    : models.find(model => model.id === selected.id)
  if (!selectedRow) throw new Error("The routed Assistant Architect model is unavailable")

  const metadata = activeRoutingMetadata({
    config,
    mode,
    routingMode: args.routingMode,
    family,
    decision,
    selected,
    proposedModelId,
    fallbackUsed,
    requirements,
  })
  log.info("Assistant Architect model routed", {
    runtimeMode: mode,
    routingMode: args.routingMode,
    requestedFamily: family,
    intent: decision.intent,
    tier: decision.tier,
    selectedModelId: selected.modelId,
    proposedModelId,
    fallbackUsed,
  })

  return {
    modelDbId: selectedRow.id,
    modelId: selectedRow.modelId,
    provider: selectedRow.provider,
    model: selectedRow,
    metadata,
  }
}
