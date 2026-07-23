import { getSettings } from "@/lib/settings-manager"
import { createLogger } from "@/lib/logger"
import {
  nexusRouterConfigSchema,
  nexusRouterRuntimeModeSchema,
  type NexusRouterConfig,
  type NexusRouterRuntimeMode,
} from "./types"

const log = createLogger({ module: "nexus-model-router-config" })

export const NEXUS_ROUTER_CONFIG_KEY = "NEXUS_ROUTER_CONFIG_V1"
export const NEXUS_ROUTER_MODE_KEY = "NEXUS_ROUTER_MODE"

export async function getNexusRouterConfig(): Promise<{
  config: NexusRouterConfig
  mode: NexusRouterRuntimeMode
}> {
  const settings = await getSettings([NEXUS_ROUTER_CONFIG_KEY, NEXUS_ROUTER_MODE_KEY])
  const rawMode = settings[NEXUS_ROUTER_MODE_KEY]
  // Standard is the product default, so a deployment with no explicit rollout
  // setting must actually route. Administrators can still choose shadow/off from
  // the dedicated Nexus routing settings card.
  const modeResult = nexusRouterRuntimeModeSchema.safeParse(rawMode ?? "active")
  const mode = modeResult.success ? modeResult.data : "shadow"
  if (!modeResult.success) {
    log.warn("Invalid Nexus router runtime mode; failing safely to shadow mode")
  }

  const rawConfig = settings[NEXUS_ROUTER_CONFIG_KEY]
  if (!rawConfig) return { config: nexusRouterConfigSchema.parse({}), mode }

  try {
    const parsedJson: unknown = JSON.parse(rawConfig)
    const parsedConfig = nexusRouterConfigSchema.safeParse(parsedJson)
    if (parsedConfig.success) return { config: parsedConfig.data, mode }
    log.warn("Invalid Nexus router configuration; using resilient defaults", {
      issueCount: parsedConfig.error.issues.length,
    })
  } catch (error) {
    log.warn("Could not parse Nexus router configuration; using resilient defaults", {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return {
    config: nexusRouterConfigSchema.parse({}),
    mode: mode === "active" ? "shadow" : mode,
  }
}
