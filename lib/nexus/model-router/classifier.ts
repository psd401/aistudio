import { generateText, tool } from "ai"
import { z } from "zod"
import { createProviderModel } from "@/lib/ai/provider-factory"
import { createLogger } from "@/lib/logger"
import {
  nexusRouterIntentSchema,
  nexusRouterTierSchema,
  type NexusClassifierDecision,
  type NexusRouterConfig,
} from "./types"

const log = createLogger({ module: "nexus-model-router-classifier" })

const IMAGE_PATTERN = /\b(generate|create|draw|design|make|edit|render)\b.{0,45}\b(image|picture|illustration|graphic|photo|poster|logo)\b|\b(image|picture|illustration|graphic|photo)\s+(generation|editing)\b/i
const PSD_PATTERN = /\b(psd[- ]?data|power\s*school|student information system|student data|attendance|enrollment|gradebook|demographic)\b/i
const INSTRUCTION_PATTERN = /\b(lesson plan|rubric|curriculum|learning objective|teaching strategy|differentiat(?:e|ion)|instructional|pedagogy|classroom activity|discussion questions)\b/i
const HIGH_PATTERN = /\b(architecture|migration|security review|threat model|root cause|research report|multi-step|optimize|prove|complex analysis)\b/i
const LIGHT_PATTERN = /^(hi|hello|thanks|thank you|yes|no|ok|okay)[!. ]*$|^(what is|who is|when is|where is|how many)\b|\b(define|translate|summarize briefly|quick question)\b/i

const classifierOutputSchema = z.object({
  intent: nexusRouterIntentSchema,
  tier: nexusRouterTierSchema,
  confidence: z.coerce.number().min(0).max(1),
  reasonCodes: z.array(z.string().min(1).max(80)).max(5).default(["nova_classifier"]),
})

export function deterministicClassify(text: string, hasImageInput = false): NexusClassifierDecision | null {
  if (hasImageInput && /\b(edit|change|remove|add|make|turn|replace|retouch|restyle|improve|enhance)\b/i.test(text)) {
    return { intent: "image", tier: "medium", confidence: 0.98, reasonCodes: ["image_edit_request"], source: "deterministic" }
  }
  if (IMAGE_PATTERN.test(text)) {
    return { intent: "image", tier: "medium", confidence: 0.99, reasonCodes: ["explicit_image_request"], source: "deterministic" }
  }
  if (PSD_PATTERN.test(text)) {
    return { intent: "psd-data", tier: "medium", confidence: 0.97, reasonCodes: ["psd_data_domain"], source: "deterministic" }
  }
  if (INSTRUCTION_PATTERN.test(text)) {
    return { intent: "instruction", tier: "medium", confidence: 0.95, reasonCodes: ["instruction_domain"], source: "deterministic" }
  }
  return null
}

export function heuristicFallback(text: string): NexusClassifierDecision {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length
  if (HIGH_PATTERN.test(text) || wordCount > 220) {
    return { intent: "general", tier: "high", confidence: 0.5, reasonCodes: ["complexity_heuristic"], source: "fallback" }
  }
  if (LIGHT_PATTERN.test(text)) {
    return { intent: "general", tier: "light", confidence: 0.5, reasonCodes: ["simple_request_heuristic"], source: "fallback" }
  }
  return { intent: "general", tier: "medium", confidence: 0.5, reasonCodes: ["safe_medium_fallback"], source: "fallback" }
}

function parseClassifierResponse(text: string): NexusClassifierDecision | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    const parsed = classifierOutputSchema.safeParse(JSON.parse(jsonMatch[0]))
    if (!parsed.success) return null
    return {
      ...parsed.data,
      source: "classifier",
    }
  } catch {
    return null
  }
}

function parseClassifierToolCall(toolCalls: unknown): NexusClassifierDecision | null {
  if (!Array.isArray(toolCalls)) return null
  for (const call of toolCalls) {
    if (!call || typeof call !== "object") continue
    const value = call as { toolName?: unknown; input?: unknown; args?: unknown }
    if (value.toolName !== "route_request") continue
    const parsed = classifierOutputSchema.safeParse(value.input ?? value.args)
    if (parsed.success) return { ...parsed.data, source: "classifier" }
  }
  return null
}

export async function classifyNexusRequest(
  text: string,
  config: NexusRouterConfig,
  context: { hasImageInput?: boolean } = {}
): Promise<NexusClassifierDecision> {
  const deterministic = deterministicClassify(text, context.hasImageInput)
  if (deterministic) return deterministic

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.classifier.timeoutMs)
  try {
    const model = await createProviderModel(config.classifier.provider, config.classifier.modelId)
    const result = await generateText({
      model,
      abortSignal: controller.signal,
      maxOutputTokens: 120,
      temperature: 0,
      system: "You are a fast request router. Use the route_request tool. If tool use is unavailable, return JSON only with no markdown.",
      prompt: `Classify the request for an education-focused assistant.\n\nIntent must be one of general, instruction, psd-data, image. Use instruction for pedagogy, lesson planning, rubrics, curriculum, differentiation, or teaching strategy. Use psd-data when answering requires district student-information-system records such as rosters, schedules, grades, attendance, enrollment, or student demographics; do not use it for generic advice about students. Use image when the user wants to generate or edit an image${context.hasImageInput ? "; an image is attached to this request" : ""}. Tier must be light for short/simple transformations and factual questions, medium for normal synthesis and planning, high only for complex multi-stage reasoning, architecture, difficult coding, or deep analysis.\n\nReturn exactly: {"intent":"general","tier":"medium","confidence":0.8,"reasonCodes":["short_reason"]}\n\nRequest:\n${text.slice(0, 8_000)}`,
      tools: {
        route_request: tool({
          description: "Return the routing decision for this request",
          inputSchema: classifierOutputSchema,
        }),
      },
      toolChoice: { type: "tool", toolName: "route_request" },
    })
    const parsed = parseClassifierToolCall(result.toolCalls) ?? parseClassifierResponse(result.text)
    if (parsed && parsed.confidence >= config.confidenceFloor) return parsed
    log.warn("Nova classifier returned an invalid or low-confidence decision; using fallback", {
      parsed: !!parsed,
      confidence: parsed?.confidence,
    })
  } catch (error) {
    log.warn("Nova classifier unavailable; using deterministic fallback", {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    clearTimeout(timeout)
  }
  return heuristicFallback(text)
}
