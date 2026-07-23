import { z } from "zod"

export const nexusExperienceModeSchema = z.enum(["standard", "advanced"])
export const nexusModelFamilySchema = z.enum(["auto", "openai", "anthropic", "google"])
export const nexusRouterTierSchema = z.enum(["light", "medium", "high"])
export const nexusRouterIntentSchema = z.enum([
  "general",
  "instruction",
  "psd-data",
  "web-search",
  "image",
])
export const nexusRouterRuntimeModeSchema = z.enum(["off", "shadow", "active"])

export type NexusExperienceMode = z.infer<typeof nexusExperienceModeSchema>
export type NexusModelFamily = z.infer<typeof nexusModelFamilySchema>
export type NexusRouterTier = z.infer<typeof nexusRouterTierSchema>
export type NexusRouterIntent = z.infer<typeof nexusRouterIntentSchema>
export type NexusRouterRuntimeMode = z.infer<typeof nexusRouterRuntimeModeSchema>

const candidateListSchema = z.array(z.string().min(1)).max(10).default([])
const tierCandidatesSchema = z.object({
  light: candidateListSchema,
  medium: candidateListSchema,
  high: candidateListSchema,
})

export const nexusRouterConfigSchema = z.object({
  version: z.string().min(1).max(50).default("1"),
  classifier: z.object({
    provider: z.string().min(1).default("amazon-bedrock"),
    modelId: z.string().min(1).default("us.amazon.nova-micro-v1:0"),
    timeoutMs: z.number().int().min(500).max(10_000).default(2_500),
  }).default({
    provider: "amazon-bedrock",
    modelId: "us.amazon.nova-micro-v1:0",
    timeoutMs: 2_500,
  }),
  families: z.object({
    openai: tierCandidatesSchema,
    anthropic: tierCandidatesSchema,
    google: tierCandidatesSchema,
  }).default({
    openai: { light: [], medium: [], high: [] },
    anthropic: { light: [], medium: [], high: [] },
    google: { light: [], medium: [], high: [] },
  }),
  auto: tierCandidatesSchema.default({ light: [], medium: [], high: [] }),
  specialists: z.object({
    imageModels: z.array(z.string().min(1)).max(10).default([
      "gemini-3.1-flash-image-preview",
      "gemini-3.1-flash-image",
    ]),
    instructionModels: z.array(z.string().min(1)).max(10).default([
      "gemini-3.5-flash",
      "gemini-3-flash-preview",
      "gemini-2.5-flash",
    ]),
    webSearchModels: z.array(z.string().min(1)).max(10).default([
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-flash",
    ]),
    psdDataConnectorId: z.string().uuid().optional(),
    psdDataConnectorName: z.string().min(1).max(255).default("psd-data"),
  }).default({
    imageModels: ["gemini-3.1-flash-image-preview", "gemini-3.1-flash-image"],
    instructionModels: ["gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash"],
    webSearchModels: [
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-flash",
    ],
    psdDataConnectorName: "psd-data",
  }),
  confidenceFloor: z.number().min(0).max(1).default(0.55),
})

export type NexusRouterConfig = z.infer<typeof nexusRouterConfigSchema>

export interface NexusClassifierDecision {
  intent: NexusRouterIntent
  tier: NexusRouterTier
  confidence: number
  reasonCodes: string[]
  source: "deterministic" | "classifier" | "fallback"
}

export interface NexusRoutingMetadata {
  version: string
  runtimeMode: NexusRouterRuntimeMode
  experienceMode: NexusExperienceMode
  requestedFamily: NexusModelFamily
  selectedFamily: Exclude<NexusModelFamily, "auto"> | "fallback"
  intent: NexusRouterIntent
  tier: NexusRouterTier
  confidence: number
  reasonCodes: string[]
  decisionSource: NexusClassifierDecision["source"]
  selectedModelId: string
  proposedModelId?: string
  fallbackUsed: boolean
  autoAttachedPsdData: boolean
  autoEnabledWebSearch: boolean
}

export interface NexusRouteResult {
  modelId: string
  connectorIds: string[]
  automaticConnectorIds: string[]
  automaticToolNames: string[]
  metadata: NexusRoutingMetadata
}
