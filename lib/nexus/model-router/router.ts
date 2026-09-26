import { getNexusEnabledModels } from "@/lib/db/drizzle"
import { filterAccessibleResourceIds } from "@/lib/db/drizzle/resource-access"
import { createLogger } from "@/lib/logger"
import { hasCapability } from "@/lib/ai/capability-utils"
import { getConfiguredChatProviders } from "@/lib/ai/provider-credentials"
import {
  inferModelFamily,
  inferModelTier,
  selectRoutedTextModel,
} from "@/lib/ai/model-router/core"
import { classifyNexusRequest } from "./classifier"
import { containsExplicitUrl } from "./url-detection"
import { getNexusRouterConfig } from "./config"
import { resolvePsdDataConnectorId } from "./psd-data-connector"
import {
  workspaceNeedsPsdData,
  type NexusWorkspaceRoutingContext,
} from "../workspace-routing-contract"
import { NexusSpecialistUnavailableError } from "./errors"
import type {
  NexusClassifierDecision,
  NexusExperienceMode,
  NexusModelFamily,
  NexusRouteResult,
  NexusRouterConfig,
  NexusRouterIntent,
  NexusRouterRuntimeMode,
  NexusRouterTier,
} from "./types"

const log = createLogger({ module: "nexus-model-router" })

type NexusModelRow = Awaited<ReturnType<typeof getNexusEnabledModels>>[number]
// Latimer is intentionally executable only through provider-neutral Standard/Auto
// candidates; it is not exposed as one of the three Advanced model families.
const EXECUTABLE_PROVIDERS = new Set(["openai", "google", "amazon-bedrock", "azure", "latimer"])

export const inferFamily = inferModelFamily
export const inferTier = inferModelTier

export function mergeRoutedToolNames(
  manuallyEnabledToolNames: string[],
  automaticToolNames: string[]
): string[] {
  return [...new Set([...manuallyEnabledToolNames, ...automaticToolNames])]
}

function configuredCandidates(
  config: NexusRouterConfig,
  family: NexusModelFamily,
  tier: NexusRouterTier,
  intent: NexusRouterIntent
): string[] {
  if (intent === "image") return config.specialists.imageModels
  if (intent === "web-search") return config.specialists.webSearchModels
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
  requiredTools: string[]
  /** Demand function calling even when no named tool is required (#1786). */
  requiresFunctionCalling?: boolean
}): { model: NexusModelRow; fallbackUsed: boolean } {
  const configuredIds = configuredCandidates(args.config, args.family, args.tier, args.intent)
  // A specialist-only image model cannot first call server-side input tools.
  // When attachments or other tools are required, keep the request on a text
  // model that can retrieve context and participate in the normal tool loop.
  if (args.intent === "image" && args.requiredTools.length === 0) {
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
    requirements: {
      requiredTools: args.requiredTools,
      requiresFunctionCalling: args.requiredTools.length > 0 || args.requiresFunctionCalling === true,
    },
    additionalEligibility: model =>
      !hasCapability(model.capabilities, "imageGeneration")
      && !hasCapability(model.capabilities, "deepResearch")
      && (args.intent !== "instruction" || args.family !== "auto" || inferFamily(model) === "google")
      && (args.intent !== "web-search" || args.family !== "auto" || inferFamily(model) === "google"),
  })
  if (routed) return { model: routed.model as NexusModelRow, fallbackUsed: routed.fallbackUsed }

  if (args.intent === "web-search") {
    throw new NexusSpecialistUnavailableError(
      "web-search",
      "Web search is not available for your selected model family or account right now. Ask an administrator to configure an accessible Gemini web-search model."
    )
  }
  if (args.family !== "auto") {
    throw new Error(`No accessible Nexus model is available in the ${args.family} family`)
  }
  throw new Error("No accessible Nexus model is available")
}

/**
 * Resolve the PSD Data connector id when this turn needs it, or null.
 *
 * `needed` is deliberately NOT just `intent === "psd-data"` (#1786): a turn
 * against an editable workspace artifact needs the data tools however its
 * sentence classifies, because "add a school dropdown" asked of an open live
 * dashboard is a schema question wearing a UI question's clothes.
 */
async function resolveAutomaticPsdConnector(
  needed: boolean,
  config: NexusRouterConfig
): Promise<string | null> {
  if (!needed) return null
  try {
    const connectorId = await resolvePsdDataConnectorId(config)
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

/**
 * Pick the executed model, preferring one that can call the tools this turn
 * depends on. Selection runs before those tools are attached, so without this a
 * turn could bind `query_data` beside a model that can never invoke it (#1786).
 *
 * Two turn shapes need it:
 *   - PSD Data (#1786) — the connector is attached only by active routing.
 *   - A pasted URL (#1696) — `web_fetch` is universal, so a `general` decision
 *     carries no required tool and nothing else would keep the turn off a model
 *     whose `supports_function_calling` is false. Such a model answers about the
 *     link without ever opening it, which is the failure this fix exists to
 *     remove, just one step later in the pipeline.
 *
 * A PREFERENCE, not a requirement: with no function-calling model available the
 * turn keeps its normal model and the chat route's do-not-guess guidance covers
 * it, rather than failing outright. That matters most for the URL case —
 * demanding a capability here would re-introduce the hard "cannot access URLs"
 * dead end #1696 removed.
 */
function selectModelForToolUse(
  args: Parameters<typeof selectModel>[0],
  mode: Exclude<NexusRouterRuntimeMode, "off">,
  fallback: NexusModelRow,
  prefersFunctionCalling: boolean
): { model: NexusModelRow; fallbackUsed: boolean } {
  if (mode === "active" && prefersFunctionCalling) {
    try {
      return selectModel({ ...args, requiresFunctionCalling: true })
    } catch (error) {
      log.warn("No function-calling model for a tool-dependent turn; keeping the normal selection", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return args.requiredTools.length > 0
    ? selectModel(args)
    : selectModelForRuntime(args, mode, fallback)
}

interface RouteNexusRequestArgs {
  text: string
  fallbackModelId: string
  experienceMode: NexusExperienceMode
  requestedFamily: NexusModelFamily
  enabledConnectorIds: string[]
  enabledToolNames?: string[]
  userId: number
  hasImageInput?: boolean
  hasPreviousGeneratedImage?: boolean
  /**
   * The object open in the workspace panel beside the chat, already resolved
   * and view-gated (#1786). Null/absent when no workspace is open.
   */
  workspace?: NexusWorkspaceRoutingContext | null
}

function addRequiredWebSearchTool(
  decision: NexusClassifierDecision,
  requiredTools: string[]
): void {
  if (
    decision.intent === "web-search"
    && !requiredTools.includes("webSearch")
  ) {
    requiredTools.push("webSearch")
  }
}

/**
 * The PSD Data connector that carries the data tools for a workspace turn, or
 * null when this turn is not a workspace-artifact turn / the connector cannot be
 * resolved at all (#1786).
 *
 * Resolved for ALL THREE runtime modes, because the chat route uses it to ask a
 * question the router cannot answer: did those tools actually reach the model?
 * Access control, a downed MCP server and a skill's `allowed-tools` pin all bite
 * AFTER routing, so the router reports WHICH connector it meant rather than
 * asserting that it worked.
 */
async function resolveWorkspacePsdDataConnectorId(options: {
  workspace: NexusWorkspaceRoutingContext | null | undefined
  config: NexusRouterConfig
  psdConnectorId?: string | null
}): Promise<string | null> {
  if (!workspaceNeedsPsdData(options.workspace)) return null
  return options.psdConnectorId !== undefined
    ? options.psdConnectorId
    : await resolveAutomaticPsdConnector(true, options.config)
}

async function buildRouterOffResult(options: {
  args: RouteNexusRequestArgs
  config: NexusRouterConfig
  models: NexusModelRow[]
  fallback: NexusModelRow
  accessibleIds: Set<string>
  requiredTools: string[]
}): Promise<NexusRouteResult> {
  const { args, config, models, fallback, accessibleIds, requiredTools } = options
  let selected = fallback
  let fallbackUsed = false
  const reasonCodes = ["router_off"]
  if (requiredTools.length > 0) {
    const selection = selectModel({
      models,
      config,
      family: args.requestedFamily,
      tier: inferTier(fallback),
      intent: "general",
      fallbackModelId: args.fallbackModelId,
      accessibleIds,
      requiredTools,
    })
    selected = selection.model
    fallbackUsed = selection.fallbackUsed
    reasonCodes.push("required_tools_enforced")
  }
  // Router-off attaches nothing, but an open artifact still needs the route to
  // be able to tell whether the user switched PSD Data on themselves (#1786) —
  // otherwise this deployment keeps the bug the fix exists for.
  const workspacePsdDataConnectorId = await resolveWorkspacePsdDataConnectorId({
    workspace: args.workspace,
    config,
  })
  return {
    modelId: selected.modelId,
    connectorIds: args.enabledConnectorIds,
    automaticConnectorIds: [],
    automaticToolNames: [],
    workspacePsdDataConnectorId,
    metadata: {
      version: config.version,
      runtimeMode: "off",
      experienceMode: args.experienceMode,
      requestedFamily: args.requestedFamily,
      selectedFamily: inferFamily(selected) ?? "fallback",
      intent: "general",
      tier: inferTier(selected),
      confidence: 1,
      reasonCodes,
      decisionSource: "fallback",
      selectedModelId: selected.modelId,
      fallbackUsed,
      autoAttachedPsdData: false,
      autoEnabledWebSearch: false,
    },
  }
}

function selectedRuntimeModel(
  mode: Exclude<NexusRouterRuntimeMode, "off">,
  requiredTools: string[],
  fallback: NexusModelRow,
  selection: { model: NexusModelRow }
): NexusModelRow {
  if (mode === "shadow" && requiredTools.length === 0) return fallback
  return selection.model
}

/** Ascending, so a floor is a plain index comparison. */
const TIER_RANK: Record<NexusRouterTier, number> = { light: 1, medium: 2, high: 3 }

/**
 * The lowest tier an editable-artifact turn may run on (#1840).
 *
 * #1786 gave those turns the PSD Data tools; this gives them a model that
 * reliably decides to USE them. The classifier rates the latest message alone,
 * with no history and no knowledge that an artifact is open, so the shortest
 * follow-ups in an authoring session — "did that work?", "can you turn live data
 * back on?" — score `light` and run on the light tier. Those are exactly the
 * turns that need tool use: read the current artifact, check the preview
 * diagnostics, write a new version. Observed on the light tier instead: no tool
 * calls at all, and invented UI ("a Live data toggle in the panel header") in
 * place of the `update_workspace_artifact` call that would have done the job.
 *
 * A FLOOR, never a cap: a `high` classification keeps its own tier.
 *
 * Scoped by the same predicate as the connector attach, so documents and
 * read-only viewers are untouched and the extra cost lands only on
 * artifact-authoring turns — where a wrong answer is a broken dashboard.
 */
const WORKSPACE_ARTIFACT_MIN_TIER: NexusRouterTier = "medium"

/**
 * Raise a classified decision to the artifact-authoring tier floor, recording
 * `workspace_artifact_min_tier` when it actually changed the tier.
 *
 * Returns the decision UNTOUCHED (same object) when there is nothing to raise,
 * so a turn with no workspace, a document, a read-only viewer, or an already
 * sufficient tier carries no extra reason code and routes exactly as before.
 */
export function applyWorkspaceArtifactTierFloor(
  decision: NexusClassifierDecision,
  workspace: NexusWorkspaceRoutingContext | null | undefined
): NexusClassifierDecision {
  if (!workspaceNeedsPsdData(workspace)) return decision
  if (TIER_RANK[decision.tier] >= TIER_RANK[WORKSPACE_ARTIFACT_MIN_TIER]) return decision
  return {
    ...decision,
    tier: WORKSPACE_ARTIFACT_MIN_TIER,
    reasonCodes: [...decision.reasonCodes, "workspace_artifact_min_tier"],
  }
}

/**
 * The classifier's own reason codes plus what routing added on top of them, so
 * the stored per-message metadata explains the turn's tools after the fact.
 */
function buildReasonCodes(options: {
  decision: NexusClassifierDecision
  requiredTools: string[]
  workspaceWantsPsdData: boolean
  /** Whether the connector reached the turn's connector list — NOT whether its
   *  tools bound, which only the chat route can know. Telemetry, not behaviour. */
  workspacePsdDataAttached: boolean
}): string[] {
  const reasonCodes = [...options.decision.reasonCodes]
  if (options.requiredTools.length > 0) reasonCodes.push("required_tools_enforced")
  if (options.workspaceWantsPsdData) {
    reasonCodes.push(
      options.workspacePsdDataAttached
        ? "workspace_artifact_psd_data"
        : "workspace_psd_data_unavailable"
    )
  }
  return reasonCodes
}

async function buildRoutedResult(options: {
  args: RouteNexusRequestArgs
  config: NexusRouterConfig
  mode: Exclude<NexusRouterRuntimeMode, "off">
  fallback: NexusModelRow
  decision: NexusClassifierDecision
  selection: { model: NexusModelRow; fallbackUsed: boolean }
  psdConnectorId: string | null
  requiredTools: string[]
}): Promise<NexusRouteResult> {
  const {
    args,
    config,
    mode,
    fallback,
    decision,
    selection,
    psdConnectorId,
    requiredTools,
  } = options
  const retainFallback = mode === "shadow" && requiredTools.length === 0
  const selected = selectedRuntimeModel(
    mode,
    requiredTools,
    fallback,
    selection
  )
  const proposedConnectors = psdConnectorId
    ? [...new Set([...args.enabledConnectorIds, psdConnectorId])]
    : args.enabledConnectorIds
  const connectorIds =
    mode === "shadow" ? args.enabledConnectorIds : proposedConnectors
  const autoEnabledWebSearch =
    mode === "active" && decision.intent === "web-search"
  const autoAttachedPsdData = mode === "active" && Boolean(psdConnectorId)
  const workspaceWantsPsdData = workspaceNeedsPsdData(args.workspace)
  const workspacePsdDataConnectorId = await resolveWorkspacePsdDataConnectorId({
    workspace: args.workspace,
    config,
    psdConnectorId,
  })
  const reasonCodes = buildReasonCodes({
    decision,
    requiredTools,
    workspaceWantsPsdData,
    workspacePsdDataAttached:
      workspacePsdDataConnectorId !== null
      && connectorIds.includes(workspacePsdDataConnectorId),
  })

  return {
    modelId: selected.modelId,
    connectorIds,
    // REQUIRED connectors only — the ones the user's own message asked for. A
    // workspace-artifact turn asked for something else ("add a dropdown"), so
    // its connector must never join this list: `resolveToolsAndStream` fails
    // the WHOLE turn when an id here cannot be connected, and doing that to
    // every edit made by a user who lacks PSD Data access would be a far worse
    // bug than the one this fix exists for (#1786).
    automaticConnectorIds:
      autoAttachedPsdData && psdConnectorId && decision.intent === "psd-data"
        ? [psdConnectorId]
        : [],
    automaticToolNames: autoEnabledWebSearch ? ["webSearch"] : [],
    workspacePsdDataConnectorId,
    metadata: {
      version: config.version,
      runtimeMode: mode,
      experienceMode: args.experienceMode,
      requestedFamily: args.requestedFamily,
      selectedFamily: inferFamily(selected) ?? "fallback",
      intent: decision.intent,
      tier: decision.tier,
      confidence: decision.confidence,
      reasonCodes,
      decisionSource: decision.source,
      selectedModelId: selected.modelId,
      proposedModelId:
        mode === "shadow" ? selection.model.modelId : undefined,
      fallbackUsed:
        selection.fallbackUsed
        || (
          retainFallback
          && selection.model.modelId !== fallback.modelId
        ),
      autoAttachedPsdData,
      autoEnabledWebSearch,
    },
  }
}

/**
 * Select the model, degrading a URL + current-info turn to a fetch-only turn
 * when web search is unavailable (#1696).
 *
 * "Summarize <url> and give today's weather" classifies as web-search, which
 * requires a search-capable model and throws NexusSpecialistUnavailableError
 * when none is accessible. For a message that names a page, that would refuse
 * the link outright, which is the bug #1696 fixed. So that implicit case (the
 * classifier's `explicit_url_web_fetch` reason code on a web-search decision)
 * falls back to `general` with `web_fetch` only: the page is still read, and
 * only the live-search half is lost. An EXPLICIT "search the web" request does
 * not carry that code, so it keeps the specialist-unavailable error rather than
 * silently skipping the search the user asked for. Without a URL the error
 * propagates as before.
 */
function selectWithFetchOnlyFallback(options: {
  decision: NexusClassifierDecision
  requiredTools: string[]
  select: (decision: NexusClassifierDecision) => { model: NexusModelRow; fallbackUsed: boolean }
}): { decision: NexusClassifierDecision; selection: { model: NexusModelRow; fallbackUsed: boolean } } {
  const { decision, requiredTools, select } = options
  const hadWebSearch = requiredTools.includes("webSearch")
  addRequiredWebSearchTool(decision, requiredTools)
  try {
    return { decision, selection: select(decision) }
  } catch (error) {
    if (
      !(error instanceof NexusSpecialistUnavailableError)
      || decision.intent !== "web-search"
      || !decision.reasonCodes.includes("explicit_url_web_fetch")
    ) {
      throw error
    }
    log.warn("Web search unavailable for a URL turn; routing as fetch-only", {
      error: error.message,
    })
    // Drop only the web-search requirement this decision added, never one the
    // user enabled themselves.
    if (!hadWebSearch) requiredTools.splice(requiredTools.indexOf("webSearch"), 1)
    const fetchOnly: NexusClassifierDecision = {
      ...decision,
      intent: "general",
      reasonCodes: [...decision.reasonCodes, "web_search_unavailable_fetch_only"],
    }
    return { decision: fetchOnly, selection: select(fetchOnly) }
  }
}

async function routeWithConfiguredRouter(options: {
  args: RouteNexusRequestArgs
  config: NexusRouterConfig
  mode: Exclude<NexusRouterRuntimeMode, "off">
  models: NexusModelRow[]
  fallback: NexusModelRow
  accessibleIds: Set<string>
  requiredTools: string[]
}): Promise<NexusRouteResult> {
  const {
    args,
    config,
    mode,
    models,
    fallback,
    accessibleIds,
    requiredTools,
  } = options
  // The classifier sees the latest message only. An open editable artifact is a
  // routing input it cannot know about, so the floor is applied to its verdict
  // before anything reads `tier` (#1840).
  const classified = applyWorkspaceArtifactTierFloor(
    await classifyNexusRequest(args.text, config, {
      hasImageInput: args.hasImageInput,
      hasPreviousGeneratedImage: args.hasPreviousGeneratedImage,
    }),
    args.workspace
  )
  // Shadow mode may retain a legacy fallback only when doing so is safe. A
  // server-required input tool is an authorization/correctness boundary, so
  // execute a compatible text model even while recording the proposed route.
  const wantsPsdData = classified.intent === "psd-data" || workspaceNeedsPsdData(args.workspace)
  // A link in the message means `web_fetch` has to be callable for the turn to
  // do what the user asked, even though the decision names no required tool.
  const wantsWebFetch = containsExplicitUrl(args.text)
  const { decision, selection } = selectWithFetchOnlyFallback({
    decision: classified,
    requiredTools,
    select: current => selectModelForToolUse(
      {
        models, config, family: args.requestedFamily, tier: current.tier,
        intent: current.intent, fallbackModelId: args.fallbackModelId, accessibleIds,
        requiredTools,
      },
      mode,
      fallback,
      wantsPsdData || wantsWebFetch
    ),
  })
  const psdConnectorId = await resolveAutomaticPsdConnector(wantsPsdData, config)
  // Only an explicit psd-data REQUEST fails closed. A workspace-artifact turn
  // asked for something else too ("add a dropdown"), so an unavailable
  // connector degrades to the do-not-guess guidance instead of a hard error.
  if (mode === "active" && decision.intent === "psd-data" && !psdConnectorId) {
    throw new NexusSpecialistUnavailableError(
      "psd-data",
      "PSD Data is not configured or is temporarily unavailable. Contact an administrator or try again shortly."
    )
  }
  const autoEnabledWebSearch = mode === "active" && decision.intent === "web-search"
  const selected = selectedRuntimeModel(
    mode,
    requiredTools,
    fallback,
    selection
  )

  log.info("Nexus request routed", {
    mode, intent: decision.intent, tier: decision.tier, requestedFamily: args.requestedFamily,
    selectedModelId: selected.modelId,
    proposedModelId: selection.model.modelId,
    fallbackUsed: selection.fallbackUsed, autoAttachedPsdData: !!psdConnectorId,
    autoEnabledWebSearch,
  })

  return buildRoutedResult({
    args,
    config,
    mode,
    fallback,
    decision,
    selection,
    psdConnectorId,
    requiredTools,
  })
}

export async function routeNexusRequest(
  args: RouteNexusRequestArgs
): Promise<NexusRouteResult> {
  const { config, mode } = await getNexusRouterConfig()
  const models = await getNexusEnabledModels()
  const accessibleIds = new Set(await filterAccessibleResourceIds(
    args.userId,
    "model",
    models.map(model => model.id)
  ))
  // The fallback (the model the client explicitly selected) is looked up in
  // the unfiltered list on purpose: an explicit selection keeps its honest
  // provider-configuration error instead of being silently rerouted.
  const fallback = models.find(model =>
    model.modelId === args.fallbackModelId
    || String(model.id) === args.fallbackModelId
  )
  if (!fallback) throw new Error("The fallback Nexus model is unavailable")
  // Routed selection must never pick a model whose provider credential is not
  // configured — provider creation would throw at stream time and fail the
  // whole request, which the router's fallback cannot catch.
  const configuredProviders = await getConfiguredChatProviders()
  const routableModels = models.filter(model =>
    configuredProviders.has(model.provider.toLowerCase())
  )
  if (routableModels.length < models.length) {
    const excludedProviders = [...new Set(
      models
        .filter(model => !configuredProviders.has(model.provider.toLowerCase()))
        .map(model => model.provider)
    )]
    log.info("Excluding models from routing; provider credentials not configured", {
      excludedProviders,
    })
  }
  const requiredTools = [...new Set(args.enabledToolNames ?? [])]
  if (mode === "off") {
    return buildRouterOffResult({
      args,
      config,
      models: routableModels,
      fallback,
      accessibleIds,
      requiredTools,
    })
  }
  return routeWithConfiguredRouter({
    args,
    config,
    mode,
    models: routableModels,
    fallback,
    accessibleIds,
    requiredTools,
  })
}
