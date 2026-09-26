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

/** Ascending, so a floor is a plain rank comparison. */
const TIER_RANK: Record<NexusRouterTier, number> = { light: 1, medium: 2, high: 3 }

/**
 * True only when selection genuinely cannot consult `tier`, so there is no tier
 * for a floor to govern or to miss.
 *
 * That is the image-specialist branch of `selectModel` alone, which returns a
 * capability-matched model or throws without ever reaching the tier-aware path.
 *
 * NOT every image turn: that branch is taken only while no input tool is
 * required, and an image turn WITH one falls through to ordinary tier-aware text
 * routing (the case #1840's review round 5 caught). And not `web-search` either —
 * its specialist list is consulted first, but when nothing there is eligible the
 * tier-aware sweep decides, so the floor still matters. A false "tier is
 * irrelevant here" silently drops the floor; a false negative only costs one
 * discarded preference attempt, which the caller retries without it.
 */
function selectionIgnoresTier(intent: NexusRouterIntent, requiredToolCount: number): boolean {
  return intent === "image" && requiredToolCount === 0
}

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
 * Whether routing may apply the artifact floor to this turn at all — BOTH the
 * raised tier and the `minTier` preference — without changing which model
 * actually executes (#1840).
 *
 * Shadow mode is supposed to change nothing. It keeps the legacy fallback only
 * while `requiredTools` is empty (`selectedRuntimeModel`); with a required tool
 * present it executes `selection.model`, so on those turns a raised tier would
 * pick the configured medium model — and a `minTier` preference an accessible
 * high one — and shadow would quietly reroute live traffic. Both halves of the
 * floor are therefore withheld there, leaving the turn's `metadata.tier` at the
 * classifier's own verdict and its reason codes free of the floor, which is the
 * honest record: the floor was not applied.
 *
 * Asked of the same predicate on both sides (the tier raise in
 * `routeWithConfiguredRouter`, the preferences in `selectModelForToolUse`) so the
 * two cannot drift apart.
 */
function artifactFloorMayApply(
  mode: Exclude<NexusRouterRuntimeMode, "off">,
  requiredToolCount: number
): boolean {
  return mode === "active" || requiredToolCount === 0
}

function meetsMinTier(
  model: Parameters<typeof inferTier>[0],
  minTier: NexusRouterTier | undefined
): boolean {
  return minTier === undefined || TIER_RANK[inferTier(model)] >= TIER_RANK[minTier]
}

/**
 * The artifact tier floor to pass to `selectModel`, or undefined when this turn
 * has none (#1840).
 *
 * Skipped when `selectionIgnoresTier`: filtering the image specialists by tier
 * could only discard the very model the intent requires.
 */
function workspaceArtifactMinTier(options: {
  workspaceWantsPsdData: boolean
  intent: NexusRouterIntent
  requiredToolCount: number
}): NexusRouterTier | undefined {
  if (!options.workspaceWantsPsdData) return undefined
  if (selectionIgnoresTier(options.intent, options.requiredToolCount)) return undefined
  return WORKSPACE_ARTIFACT_MIN_TIER
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
  /**
   * Exclude models BELOW this tier (#1840).
   *
   * `selectRoutedTextModel` treats `tier` as a preference and sweeps
   * `[tier, medium, light, high]`, so with the tier raised to `medium` it still
   * prefers an accessible LIGHT model over an accessible high one — landing the
   * turn on exactly the model the artifact floor exists to avoid. Passing the
   * floor here makes those models ineligible, so the sweep reaches `high`
   * instead. The caller retries without it when nothing qualifies, which keeps
   * this a preference rather than a new way to fail a turn.
   */
  minTier?: NexusRouterTier
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
      && meetsMinTier(model, args.minTier)
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
 * Since #1840 it also carries the artifact tier floor (`args.minTier`), for the
 * same reason and on the same terms.
 *
 * A PREFERENCE, not a requirement: with no function-calling model available the
 * turn keeps its normal model and the chat route's do-not-guess guidance covers
 * it, rather than failing outright. That matters most for the URL case —
 * demanding a capability here would re-introduce the hard "cannot access URLs"
 * dead end #1696 removed.
 *
 * The preferences are attempted strongest-first and are all dropped before the
 * final, unconstrained selection. Function calling outranks the tier floor: a
 * model that cannot invoke a tool is useless to an authoring turn at any tier.
 *
 * They also run in SHADOW mode, but ONLY while shadow is guaranteed not to
 * execute what they pick. Shadow's job is to answer "what would active routing
 * have chosen?", so a proposal that skipped these preferences compares the wrong
 * thing — reporting the light model (and `workspace_artifact_min_tier_unmet`) for
 * a deployment where active mode would have reached the high one.
 *
 * The exception is a shadow turn that ALSO has a required tool — see
 * `artifactFloorMayApply`. Shadow keeps its original route there and its proposal
 * stays unpreferenced: a less precise proposal is a far smaller cost than shadow
 * mode quietly rerouting live traffic.
 */
function selectModelForToolUse(
  args: Parameters<typeof selectModel>[0],
  mode: Exclude<NexusRouterRuntimeMode, "off">,
  fallback: NexusModelRow,
  prefersFunctionCalling: boolean
): { model: NexusModelRow; fallbackUsed: boolean } {
  const unconstrained = { ...args, minTier: undefined }
  const preferences: Partial<Parameters<typeof selectModel>[0]>[] = []
  if (artifactFloorMayApply(mode, args.requiredTools.length)) {
    if (prefersFunctionCalling && args.minTier) {
      preferences.push({ requiresFunctionCalling: true, minTier: args.minTier })
    }
    if (prefersFunctionCalling) preferences.push({ requiresFunctionCalling: true, minTier: undefined })
    if (args.minTier) preferences.push({ minTier: args.minTier })
  }
  for (const preference of preferences) {
    try {
      return selectModel({ ...unconstrained, ...preference })
    } catch (error) {
      log.warn("A routing preference could not be satisfied; trying the next one", {
        preference: { ...preference, minTier: preference.minTier ?? null },
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return unconstrained.requiredTools.length > 0
    ? selectModel(unconstrained)
    : selectModelForRuntime(unconstrained, mode, fallback)
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

/**
 * Whether `addRequiredWebSearchTool` is going to grow the list — the same test,
 * without the mutation.
 *
 * The artifact floor gate needs this lookahead: a web-search decision gains its
 * required `webSearch` tool inside `selectWithFetchOnlyFallback`, which is
 * precisely what makes shadow mode execute the routed model instead of the legacy
 * fallback, so the floor has to be judged against the EVENTUAL required-tool list
 * rather than the one that exists before classification is acted on (#1840).
 * Shared with the mutator so the two cannot drift.
 */
function willAddRequiredWebSearchTool(
  decision: NexusClassifierDecision,
  requiredTools: string[]
): boolean {
  return decision.intent === "web-search" && !requiredTools.includes("webSearch")
}

function addRequiredWebSearchTool(
  decision: NexusClassifierDecision,
  requiredTools: string[]
): void {
  if (willAddRequiredWebSearchTool(decision, requiredTools)) {
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

/**
 * Raise a classified decision to the artifact-authoring tier floor, recording
 * `workspace_artifact_min_tier` when it actually changed the tier.
 *
 * Returns the decision UNTOUCHED (the same object) when there is nothing to
 * raise, so a turn with no workspace, a document, a read-only viewer, or an
 * already sufficient tier carries no extra reason code and routes exactly as
 * before.
 *
 * INERT where `selectionIgnoresTier` holds: the image-specialist branch returns a
 * capability-matched model without consulting `tier`, so a raise there cannot
 * change which model is selected. The code is still recorded — it describes the
 * DECISION, and `metadata.tier` did change — but do not read it as evidence of a
 * different model on such a turn, and `workspace_artifact_min_tier_unmet` is
 * deliberately not emitted for it either.
 */
function applyWorkspaceArtifactTierFloor(
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
 * Whether the artifact tier floor was asked for but the ROUTED model still came
 * out below it (#1840) — see `workspaceArtifactTierUnmet` below for why that is
 * worth its own reason code.
 *
 * Takes the routed model, never the executed one: in shadow mode the executed
 * model is the legacy fallback by design, and the question worth monitoring in
 * every mode is whether routing could honour the floor.
 */
function workspaceArtifactTierUnmet(options: {
  workspaceWantsPsdData: boolean
  intent: NexusRouterIntent
  routedModel: NexusModelRow
  /** The turn's one `artifactFloorMayApply` decision, passed in rather than
   *  recomputed: `requiredTools` is mutated during routing, so a second
   *  evaluation here could disagree with the one that governed the tier. */
  floorApplied: boolean
  requiredToolCount: number
}): boolean {
  if (!options.workspaceWantsPsdData) return false
  // Only meaningful when the floor was actually asked for: a shadow turn with a
  // required tool never applies it, so "unmet" would report a miss on a turn that
  // never aimed.
  if (!options.floorApplied) return false
  if (selectionIgnoresTier(options.intent, options.requiredToolCount)) return false
  return TIER_RANK[inferTier(options.routedModel)] < TIER_RANK[WORKSPACE_ARTIFACT_MIN_TIER]
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
  /**
   * Whether the ROUTED model still came out below the artifact tier floor
   * (#1840). `selectRoutedTextModel` treats a tier as a preference and sweeps
   * `[tier, medium, light, high]` when nothing in the requested tier is
   * accessible, so a deployment with no configured medium candidates — or a user
   * whose role grants only light models — lands back on a light model while
   * `metadata.tier` reads `medium`. Without this code the presence of
   * `workspace_artifact_min_tier` would look like proof the fix is live on turns
   * where it was silently defeated, and the #1786-style guessing could recur
   * unseen.
   */
  workspaceArtifactTierUnmet: boolean
}): string[] {
  const reasonCodes = [...options.decision.reasonCodes]
  if (options.requiredTools.length > 0) reasonCodes.push("required_tools_enforced")
  if (options.workspaceWantsPsdData) {
    reasonCodes.push(
      options.workspacePsdDataAttached
        ? "workspace_artifact_psd_data"
        : "workspace_psd_data_unavailable"
    )
    if (options.workspaceArtifactTierUnmet) {
      reasonCodes.push("workspace_artifact_min_tier_unmet")
    }
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
    workspaceArtifactTierUnmet: workspaceArtifactTierUnmet({
      workspaceWantsPsdData,
      intent: decision.intent,
      routedModel: selection.model,
      // The LIVE list, which is the one the final decision was floored against:
      // `refloor` re-applies the gate after the fetch-only retry removes the tool,
      // so this evaluation and the tier can no longer disagree.
      floorApplied: artifactFloorMayApply(mode, requiredTools.length),
      requiredToolCount: requiredTools.length,
    }),
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
  /**
   * Re-apply the artifact tier floor to the RETRY decision (#1840).
   *
   * The retry removes the `webSearch` tool this function added, so the turn's
   * required-tool list — and with it whether the floor may be applied at all —
   * is not what it was when the original decision was floored. Handed in as a
   * callback rather than recomputed here so this module keeps knowing nothing
   * about workspaces.
   */
  refloor: (decision: NexusClassifierDecision) => NexusClassifierDecision
}): { decision: NexusClassifierDecision; selection: { model: NexusModelRow; fallbackUsed: boolean } } {
  const { decision, requiredTools, select, refloor } = options
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
    // Refloored AFTER the splice: the retry may now qualify for the floor that the
    // added tool disqualified the original decision from.
    const fetchOnly = refloor({
      ...decision,
      intent: "general",
      reasonCodes: [...decision.reasonCodes, "web_search_unavailable_fetch_only"],
    })
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
  const rawDecision = await classifyNexusRequest(args.text, config, {
    hasImageInput: args.hasImageInput,
    hasPreviousGeneratedImage: args.hasPreviousGeneratedImage,
  })
  // The classifier sees the latest message only. An open editable artifact is a
  // routing input it cannot know about, so the floor is applied to its verdict
  // before anything reads `tier` (#1840) — unless doing so would change what
  // shadow mode EXECUTES, which `artifactFloorMayApply` explains. Judged against
  // the EVENTUAL required-tool list, because a web-search decision has not yet
  // added its own tool at this point.
  //
  // Everything downstream of this point reads the LIVE `requiredTools` instead,
  // because by then the tool has been added — and the fetch-only retry may have
  // removed it again, which is why `refloor` exists.
  const floorAppliesToLiveToolList = (): boolean =>
    artifactFloorMayApply(mode, requiredTools.length)
  const floorDecision = (candidate: NexusClassifierDecision): NexusClassifierDecision =>
    floorAppliesToLiveToolList()
      ? applyWorkspaceArtifactTierFloor(candidate, args.workspace)
      : candidate
  const classified = artifactFloorMayApply(
    mode,
    requiredTools.length + (willAddRequiredWebSearchTool(rawDecision, requiredTools) ? 1 : 0)
  )
    ? applyWorkspaceArtifactTierFloor(rawDecision, args.workspace)
    : rawDecision
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
    refloor: floorDecision,
    // `current.intent`, not `classified.intent`: the fetch-only fallback rewrites
    // a web-search decision to `general`, and the retry must then be governed by
    // the floor the rewritten intent actually has (#1840).
    select: current => selectModelForToolUse(
      {
        models, config, family: args.requestedFamily, tier: current.tier,
        intent: current.intent, fallbackModelId: args.fallbackModelId, accessibleIds,
        requiredTools,
        minTier: floorAppliesToLiveToolList()
          ? workspaceArtifactMinTier({
            workspaceWantsPsdData: workspaceNeedsPsdData(args.workspace),
            intent: current.intent,
            requiredToolCount: requiredTools.length,
          })
          : undefined,
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
