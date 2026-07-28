import {
  generateText,
  tool,
  type LanguageModel,
} from "ai"
import { createProviderModel } from "@/lib/ai/provider-factory"
import { getSetting } from "@/lib/settings-manager"
import {
  buildMemoryImportExtractionPrompt,
  MEMORY_IMPORT_EXTRACTION_SYSTEM_PROMPT,
} from "./import-prompts"
import {
  MemoryImportCandidateBatchSchema,
  type MemoryImportCandidate,
  type MemoryImportVendor,
} from "./memory-import-schemas"

export const DEFAULT_MEMORY_EXTRACTION_MODEL_ID =
  "us.amazon.nova-lite-v1:0"
const MEMORY_EXTRACTION_PROVIDER = "amazon-bedrock"
const EXTRACTION_TOOL_NAME = "submit_memory_candidates"

interface ModelExtractionResult {
  text: string
  toolCalls: unknown
}

interface MemoryImportExtractorDependencies {
  getSetting(key: string): Promise<string | null>
  createModel(provider: string, modelId: string): Promise<LanguageModel>
  runExtraction(
    model: LanguageModel,
    prompt: string,
  ): Promise<ModelExtractionResult>
}

function parseJsonBatch(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

export function parseMemoryImportCandidates(
  result: ModelExtractionResult,
): MemoryImportCandidate[] {
  if (Array.isArray(result.toolCalls)) {
    for (const call of result.toolCalls) {
      if (!call || typeof call !== "object") continue
      const value = call as {
        toolName?: unknown
        input?: unknown
        args?: unknown
      }
      if (value.toolName !== EXTRACTION_TOOL_NAME) continue
      const parsed = MemoryImportCandidateBatchSchema.safeParse(
        value.input ?? value.args,
      )
      if (parsed.success) return parsed.data.candidates
    }
  }

  const parsed = MemoryImportCandidateBatchSchema.safeParse(
    parseJsonBatch(result.text),
  )
  if (parsed.success) return parsed.data.candidates
  throw new Error("The memory extraction model returned an invalid response")
}

export function createMemoryImportExtractor(
  dependencies: MemoryImportExtractorDependencies,
) {
  return async function extractMemoryImportCandidates(input: {
    vendor: MemoryImportVendor
    pastedText: string
  }): Promise<MemoryImportCandidate[]> {
    const configuredModelId = await dependencies.getSetting(
      "MEMORY_EXTRACTION_MODEL_ID",
    )
    const modelId =
      configuredModelId?.trim() || DEFAULT_MEMORY_EXTRACTION_MODEL_ID
    const model = await dependencies.createModel(
      MEMORY_EXTRACTION_PROVIDER,
      modelId,
    )
    const result = await dependencies.runExtraction(
      model,
      buildMemoryImportExtractionPrompt(input.vendor, input.pastedText),
    )
    return parseMemoryImportCandidates(result)
  }
}

export const extractMemoryImportCandidates = createMemoryImportExtractor({
  getSetting,
  createModel: createProviderModel,
  runExtraction: async (model, prompt) => {
    const result = await generateText({
      model,
      system: MEMORY_IMPORT_EXTRACTION_SYSTEM_PROMPT,
      prompt,
      temperature: 0,
      maxOutputTokens: 8_192,
      tools: {
        [EXTRACTION_TOOL_NAME]: tool({
          description:
            "Return the durable memory candidates extracted from the source data",
          inputSchema: MemoryImportCandidateBatchSchema,
        }),
      },
      toolChoice: {
        type: "tool",
        toolName: EXTRACTION_TOOL_NAME,
      },
    })
    return {
      text: result.text,
      toolCalls: result.toolCalls,
    }
  },
})
