import { eq } from "drizzle-orm"
import { getNexusEnabledModels } from "@/lib/db/drizzle"
import { executeQuery } from "@/lib/db/drizzle-client"
import { nexusMcpServers } from "@/lib/db/schema"
import { filterAccessibleResourceIds } from "@/lib/db/drizzle/resource-access"
import { createLogger } from "@/lib/logger"
import { hasCapability } from "@/lib/ai/capability-utils"
import {
  inferModelFamily,
  inferModelTier,
  selectRoutedTextModel,
} from "@/lib/ai/model-router/core"
import { classifyNexusRequest } from "./classifier"
import { getNexusRouterConfig } from "./config"
import { NexusSpecialistUnavailableError } from "./errors"
import type {
  NexusExperienceMode,
  NexusModelFamily,
  NexusRouteResult,
  NexusRouterConfig,
  NexusRouterIntent,
  NexusRouterTier,
} from "./types"

const log = createLogger({ module: "nexus-model-router" })

type NexusModelRow = Awaited<ReturnType<typeof getNexusEnabledModels>>[number]
// Latimer is intentionally executable only through provider-neutral Standard/Auto
// candidates; it is not exposed as one of the three Advanced model families.
const EXECUTABLE_PROVIDERS = new Set(["openai", "google", "amazon-bedrock", "azure", "latimer"])

export const inferFamily = inferModelFamily
export const inferTier = inferModelTier

function configuredCandidates(
  config: NexusRouterConfig,
  family: NexusModelFamily,
  tier: NexusRouterTier,
  intent: NexusRouterIntent
): string[] {
  if (intent === "image") return config.specialists.imageModels
  if (intent === "instruction" && family === "auto" && config.specialists.instructionModels.length > 0) {
    return config.specialists.instructionModels
  }
  if (family === "auto") return config.auto[tier]
  return config.families[family][tier]
}

function firstAccessibleModel(
  candidates: NexusModelRow[],
  accessibleIds: Set<string>
): NexusModelRow | null {
  for (const candidate of candidates) {
    if (!EXECUTABLE_PROVIDERS.has(candidate.provider.toLowerCase())) continue
    if (accessibleIds.has(String(candidate.id))) return candidate
  }
  return null
}

function selectModel(args: {
  models: NexusModelRow[]
  config: NexusRouterConfig
  family: NexusModelFamily
  tier: NexusRouterTier
  intent: NexusRouterIntent
  fallbackModelId: string
  accessibleIds: Set<string>
}): { model: NexusModelRow; fallbackUsed: boolean } {
  const configuredIds = configuredCandidates(args.config, args.family, args.tier, args.intent)
  if (args.intent === "image") {
    const configured = configuredIds
      .map(id => args.models.find(model => model.modelId === id || String(model.id) === id))
      .filter((model): model is NexusModelRow => model !== undefined)
      .filter(model =>
        (model.provider === "google" || model.provider === "openai")
        && hasCapability(model.capabilities, "imageGeneration")
      )
    const configuredSelection = firstAccessibleModel(configured, args.accessibleIds)
    if (configuredSelection) return { model: configuredSelection, fallbackUsed: false }
    const inferred = args.models.filter(model =>
      (model.provider === "google" || model.provider === "openai")
      && hasCapability(model.capabilities, "imageGeneration")
    )
    const inferredSelection = firstAccessibleModel(inferred, args.accessibleIds)
    if (inferredSelection) return { model: inferredSelection, fallbackUsed: configuredIds.length > 0 }
    throw new NexusSpecialistUnavailableError(
      "image",
      "Image generation is not available for your account right now. Ask an administrator to configure an accessible image model."
    )
  }

  const routed = selectRoutedTextModel({
    models: args.models,
    configuredCandidateIds: configuredIds,
    accessibleIds: args.accessibleIds,
    family: args.family,
    tier: args.tier,
    fallbackModelId: args.fallbackModelId,
    additionalEligibility: model =>
      !hasCapability(model.capabilities, "imageGeneration")
      && (args.intent !== "instruction" || args.family !== "auto" || inferFamily(model) === "google"),
  })
  if (routed) return { model: routed.model as NexusModelRow, fallbackUsed: routed.fallbackUsed }

  if (args.family !== "auto") {
    throw new Error(`No accessible Nexus model is available in the ${args.family} family`)
  }
  throw new Error("No accessible Nexus model is available")
}

async function resolvePsdDataConnector(config: NexusRouterConfig): Promise<string | null> {
  if (config.specialists.psdDataConnectorId) {
    const [row] = await executeQuery(
      db => db.select({ id: nexusMcpServers.id }).from(nexusMcpServers)
        .where(eq(nexusMcpServers.id, config.specialists.psdDataConnectorId!)).limit(1),
      "resolvePsdDataConnectorById"
    )
    return row?.id ?? null
  }
  const rows = await executeQuery(
    db => db.select({ id: nexusMcpServers.id, name: nexusMcpServers.name }).from(nexusMcpServers),
    "resolvePsdDataConnectorByName"
  )
  const normalize = (value: string) => value.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
  const configuredName = normalize(config.specialists.psdDataConnectorName)
  return rows.find(row => normalize(row.name) === configuredName)?.id ?? null
}

async function resolveAutomaticPsdConnector(
  intent: NexusRouterIntent,
  config: NexusRouterConfig
): Promise<string | null> {
  if (intent !== "psd-data") return null
  try {
    const connectorId = await resolvePsdDataConnector(config)
    if (!connectorId) {
      log.warn("PSD-data route requested but the configured database MCP server was not found")
    }
    return connectorId
  } catch (error) {
    log.warn("PSD-data MCP lookup failed; active routing will report the unavailable specialist", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

function selectModelForRuntime(
  args: Parameters<typeof selectModel>[0],
  mode: NexusRouteResult["metadata"]["runtimeMode"],
  fallback: NexusModelRow
): { model: NexusModelRow; fallbackUsed: boolean } {
  try {
    return selectModel(args)
  } catch (error) {
    if (mode !== "shadow") throw error
    log.warn("Proposed route could not be resolved; shadow mode is retaining the legacy model", {
      error: error instanceof Error ? error.message : String(error),
    })
    return { model: fallback, fallbackUsed: true }
  }
}

export async function routeNexusRequest(args: {
  text: string
  fallbackModelId: string
  experienceMode: NexusExperienceMode
  requestedFamily: NexusModelFamily
  enabledConnectorIds: string[]
  userId: number
  hasImageInput?: boolean
  hasPreviousGeneratedImage?: boolean
}): Promise<NexusRouteResult> {
  const { config, mode } = await getNexusRouterConfig()
  const models = await getNexusEnabledModels()
  const accessibleIds = new Set(await filterAccessibleResourceIds(
    args.userId,
    "model",
    models.map(model => model.id)
  ))
  const fallback = models.find(model => model.modelId === args.fallbackModelId || String(model.id) === args.fallbackModelId)
  if (!fallback) throw new Error("The fallback Nexus model is unavailable")

  if (mode === "off") {
    return {
      modelId: fallback.modelId,
      connectorIds: args.enabledConnectorIds,
      automaticConnectorIds: [],
      metadata: {
        version: config.version, runtimeMode: mode, experienceMode: args.experienceMode,
        requestedFamily: args.requestedFamily, selectedFamily: inferFamily(fallback) ?? "fallback",
        intent: "general", tier: inferTier(fallback), confidence: 1,
        reasonCodes: ["router_off"], decisionSource: "fallback", selectedModelId: fallback.modelId,
        fallbackUsed: false, autoAttachedPsdData: false,
      },
    }
  }

  const decision = await classifyNexusRequest(args.text, config, {
    hasImageInput: args.hasImageInput,
    hasPreviousGeneratedImage: args.hasPreviousGeneratedImage,
  })
  const selection = selectModelForRuntime({
    models, config, family: args.requestedFamily, tier: decision.tier,
    intent: decision.intent, fallbackModelId: args.fallbackModelId, accessibleIds,
  }, mode, fallback)
  const psdConnectorId = await resolveAutomaticPsdConnector(decision.intent, config)
  if (mode === "active" && decision.intent === "psd-data" && !psdConnectorId) {
    throw new NexusSpecialistUnavailableError(
      "psd-data",
      "PSD Data is not configured or is temporarily unavailable. Contact an administrator or try again shortly."
    )
  }
  const proposedConnectors = psdConnectorId
    ? [...new Set([...args.enabledConnectorIds, psdConnectorId])]
    : args.enabledConnectorIds
  const selected = mode === "shadow" ? fallback : selection.model
  const connectorIds = mode === "shadow" ? args.enabledConnectorIds : proposedConnectors

  log.info("Nexus request routed", {
    mode, intent: decision.intent, tier: decision.tier, requestedFamily: args.requestedFamily,
    selectedModelId: selected.modelId, proposedModelId: selection.model.modelId,
    fallbackUsed: selection.fallbackUsed, autoAttachedPsdData: !!psdConnectorId,
  })

  return {
    modelId: selected.modelId,
    connectorIds,
    automaticConnectorIds: mode === "active" && psdConnectorId ? [psdConnectorId] : [],
    metadata: {
      version: config.version,
      runtimeMode: mode,
      experienceMode: args.experienceMode,
      requestedFamily: args.requestedFamily,
      selectedFamily: inferFamily(selected) ?? "fallback",
      intent: decision.intent,
      tier: decision.tier,
      confidence: decision.confidence,
      reasonCodes: decision.reasonCodes,
      decisionSource: decision.source,
      selectedModelId: selected.modelId,
      proposedModelId: mode === "shadow" ? selection.model.modelId : undefined,
      fallbackUsed: selection.fallbackUsed || (mode === "shadow" && selection.model.modelId !== fallback.modelId),
      autoAttachedPsdData: mode === "active" && !!psdConnectorId,
    },
  }
}
