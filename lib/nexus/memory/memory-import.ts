import {
  generateText,
  tool,
  type LanguageModel,
} from "ai"
import { createProviderModel } from "@/lib/ai/provider-factory"
import { createLogger } from "@/lib/logger"
import { getSetting } from "@/lib/settings-manager"
import {
  buildMemoryImportExtractionPrompt,
  MEMORY_IMPORT_EXTRACTION_SYSTEM_PROMPT,
} from "./import-prompts"
import { MAX_MEMORY_IMPORT_CANDIDATES } from "./memory-constants"
import {
  MemoryImportCandidateBatchSchema,
  MemoryImportCandidateSchema,
  type MemoryImportCandidate,
  type MemoryImportVendor,
} from "./memory-import-schemas"

export const DEFAULT_MEMORY_EXTRACTION_MODEL_ID =
  "us.amazon.nova-lite-v1:0"
const MEMORY_EXTRACTION_PROVIDER = "amazon-bedrock"
const EXTRACTION_TOOL_NAME = "submit_memory_candidates"

/**
 * Upper bound on the source text handed to a single model call.
 *
 * A whole paste can be 200,000 characters, which asks for more candidate JSON
 * than the output-token budget holds. A tool call truncated mid-object parses
 * as nothing at all, so the entire import returned zero candidates — that is
 * what broke three prod imports on 2026-08-05. Chunking keeps every response
 * well inside the budget.
 */
export const MEMORY_EXTRACTION_CHUNK_CHARS = 12_000
const MEMORY_EXTRACTION_MAX_CONCURRENCY = 3
const MEMORY_EXTRACTION_ATTEMPTS = 2
/**
 * How many times a chunk that ran out of output budget may be halved.
 * Retrying the same prompt at temperature 0 cannot fix a response the model
 * had no room to finish — only a smaller chunk can. Bounded so a chunk that
 * fails for some other reason cannot fan out indefinitely.
 */
const MEMORY_EXTRACTION_MAX_SPLIT_DEPTH = 3
const MEMORY_EXTRACTION_MIN_CHUNK_CHARS = 500
const MEMORY_EXTRACTION_RETRY_BASE_MS = 250

/**
 * Jittered so several chunks that hit the same Bedrock throttle window do not
 * retry in lockstep — at concurrency 3 an immediate retry tends to land in the
 * window that just rejected it.
 */
function delayBeforeRetry(attempt: number): Promise<void> {
  const base = MEMORY_EXTRACTION_RETRY_BASE_MS * attempt
  return new Promise((resolve) => {
    setTimeout(resolve, base + Math.random() * base)
  })
}

const INVALID_EXTRACTION_RESPONSE =
  "The memory extraction model returned an invalid response"

const log = createLogger({ module: "nexus-memory-import" })

interface ModelExtractionUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

interface ModelExtractionResult {
  text: string
  toolCalls: unknown
  finishReason?: string
  usage?: ModelExtractionUsage
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

/**
 * Keep every individually valid candidate when the batch as a whole fails the
 * schema. One out-of-enum category, one over-long entry, or one candidate past
 * the cap used to discard the model's entire answer.
 */
function salvageCandidates(value: unknown): MemoryImportCandidate[] | null {
  if (!value || typeof value !== "object") return null
  const candidates = (value as { candidates?: unknown }).candidates
  if (!Array.isArray(candidates)) return null
  const salvaged: MemoryImportCandidate[] = []
  let capped = 0
  for (const entry of candidates) {
    // Validate before counting, so droppedCandidates reports what the cap
    // actually cost rather than including entries that were invalid anyway.
    const parsed = MemoryImportCandidateSchema.safeParse(entry)
    if (!parsed.success) continue
    if (salvaged.length >= MAX_MEMORY_IMPORT_CANDIDATES) {
      capped += 1
      continue
    }
    salvaged.push(parsed.data)
  }
  if (capped > 0) {
    // Never truncate silently: "why did my import stop at 100" has to be
    // answerable from the logs.
    log.warn("Nexus memory extraction batch exceeded the candidate cap", {
      cap: MAX_MEMORY_IMPORT_CANDIDATES,
      droppedCandidates: capped,
    })
  }
  return salvaged.length > 0 ? salvaged : null
}

function extractionPayloads(result: ModelExtractionResult): unknown[] {
  const payloads: unknown[] = []
  if (Array.isArray(result.toolCalls)) {
    for (const call of result.toolCalls) {
      if (!call || typeof call !== "object") continue
      const value = call as {
        toolName?: unknown
        input?: unknown
        args?: unknown
      }
      if (value.toolName !== EXTRACTION_TOOL_NAME) continue
      payloads.push(value.input ?? value.args)
    }
  }
  payloads.push(parseJsonBatch(result.text))
  return payloads
}

export function parseMemoryImportCandidates(
  result: ModelExtractionResult,
): MemoryImportCandidate[] {
  const payloads = extractionPayloads(result)
  for (const payload of payloads) {
    const parsed = MemoryImportCandidateBatchSchema.safeParse(payload)
    if (parsed.success) return parsed.data.candidates
  }
  for (const payload of payloads) {
    const salvaged = salvageCandidates(payload)
    if (salvaged) return salvaged
  }
  throw new Error(INVALID_EXTRACTION_RESPONSE)
}

/**
 * Split pasted text on line boundaries so each model call stays inside the
 * output budget. A single line longer than the budget is split on characters
 * because nothing else bounds it.
 */
export function splitExtractionChunks(
  pastedText: string,
  chunkChars: number = MEMORY_EXTRACTION_CHUNK_CHARS,
): string[] {
  const text = pastedText.trim()
  if (!text) return []
  if (text.length <= chunkChars) return [text]

  const chunks: string[] = []
  let current = ""
  for (const line of text.split("\n")) {
    if (line.length > chunkChars) {
      if (current) {
        chunks.push(current)
        current = ""
      }
      for (let offset = 0; offset < line.length; offset += chunkChars) {
        chunks.push(line.slice(offset, offset + chunkChars))
      }
      continue
    }
    const merged = current ? `${current}\n${line}` : line
    if (merged.length > chunkChars) {
      chunks.push(current)
      current = line
    } else {
      current = merged
    }
  }
  if (current) chunks.push(current)
  return chunks.filter((chunk) => chunk.trim().length > 0)
}

function dedupeCandidates(
  candidates: readonly MemoryImportCandidate[],
): MemoryImportCandidate[] {
  const seen = new Set<string>()
  const unique: MemoryImportCandidate[] = []
  let capped = 0
  for (const candidate of candidates) {
    if (unique.length >= MAX_MEMORY_IMPORT_CANDIDATES) {
      capped += 1
      continue
    }
    const key = candidate.content.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(candidate)
  }
  if (capped > 0) {
    log.warn("Nexus memory import exceeded the candidate cap", {
      cap: MAX_MEMORY_IMPORT_CANDIDATES,
      droppedCandidates: capped,
    })
  }
  return unique
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

interface ChunkExtractionContext {
  model: LanguageModel
  vendor: MemoryImportVendor
  chunkIndex: number
  chunkCount: number
}

// Never logs the model output or the pasted source; the shape of the response
// is what makes a failure diagnosable.
function logChunkFailure(
  context: ChunkExtractionContext,
  failure: {
    chunk: string
    splitDepth: number
    attempt: number
    result?: ModelExtractionResult
    error: unknown
  },
): void {
  const { result } = failure
  log.warn("Nexus memory extraction returned an unparseable response", {
    vendor: context.vendor,
    chunkIndex: context.chunkIndex,
    chunkCount: context.chunkCount,
    attempt: failure.attempt,
    splitDepth: failure.splitDepth,
    chunkChars: failure.chunk.length,
    finishReason: result?.finishReason,
    outputTextChars: result?.text.length ?? 0,
    toolCallCount:
      result && Array.isArray(result.toolCalls)
        ? result.toolCalls.length
        : 0,
    inputTokens: result?.usage?.inputTokens,
    outputTokens: result?.usage?.outputTokens,
    error: toError(failure.error).message,
  })
}

export function createMemoryImportExtractor(
  dependencies: MemoryImportExtractorDependencies,
) {
  /**
   * Halve a chunk the model had no output budget to finish, and extract the
   * halves. Returns null when splitting is not possible or nothing recovered.
   */
  async function extractSplitHalves(
    context: ChunkExtractionContext,
    chunk: string,
    splitDepth: number,
  ): Promise<MemoryImportCandidate[] | null> {
    if (splitDepth >= MEMORY_EXTRACTION_MAX_SPLIT_DEPTH) return null
    if (chunk.length <= MEMORY_EXTRACTION_MIN_CHUNK_CHARS) return null
    const halves = splitExtractionChunks(chunk, Math.ceil(chunk.length / 2))
    if (halves.length < 2) return null

    log.warn("Splitting a Nexus memory extraction chunk that overran", {
      vendor: context.vendor,
      chunkIndex: context.chunkIndex,
      splitDepth,
      chunkChars: chunk.length,
      halves: halves.length,
    })
    const settled = await Promise.allSettled(
      halves.map((half) => extractChunk(context, half, splitDepth + 1)),
    )
    const fulfilled = settled.filter(
      (
        outcome,
      ): outcome is PromiseFulfilledResult<MemoryImportCandidate[]> =>
        outcome.status === "fulfilled",
    )
    // Half the chunk landing is still better than losing all of it.
    if (fulfilled.length === 0) return null
    return fulfilled.flatMap((outcome) => outcome.value)
  }

  async function extractChunk(
    context: ChunkExtractionContext,
    chunk: string,
    splitDepth = 0,
  ): Promise<MemoryImportCandidate[]> {
    const prompt = buildMemoryImportExtractionPrompt(context.vendor, chunk)
    let ranOutOfBudget = false
    for (
      let attempt = 1;
      attempt <= MEMORY_EXTRACTION_ATTEMPTS;
      attempt += 1
    ) {
      // runExtraction is inside the try so a throttled or dropped Bedrock call
      // gets the retry too, not just an unparseable response.
      let result: ModelExtractionResult | undefined
      try {
        result = await dependencies.runExtraction(context.model, prompt)
        return parseMemoryImportCandidates(result)
      } catch (error) {
        ranOutOfBudget = result?.finishReason === "length"
        logChunkFailure(context, {
          chunk,
          splitDepth,
          attempt,
          result,
          error,
        })
        // No point pausing before a retry that will not happen, and none
        // before a split — a smaller chunk is not competing for the same
        // throttle window.
        if (attempt < MEMORY_EXTRACTION_ATTEMPTS && !ranOutOfBudget) {
          await delayBeforeRetry(attempt)
        }
      }
    }

    // A chunk that ran out of output budget truncates identically on every
    // identical retry. Splitting it — not retrying it — is what actually
    // clears the failure mode the 2026-08-05 incident hit.
    if (ranOutOfBudget) {
      const recovered = await extractSplitHalves(context, chunk, splitDepth)
      if (recovered) return recovered
    }
    throw new Error(INVALID_EXTRACTION_RESPONSE)
  }

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
    const chunks = splitExtractionChunks(input.pastedText)
    if (chunks.length === 0) return []

    const collected: MemoryImportCandidate[][] = chunks.map(() => [])
    const failures: Error[] = []
    let nextChunk = 0
    const workers = Array.from(
      { length: Math.min(MEMORY_EXTRACTION_MAX_CONCURRENCY, chunks.length) },
      async () => {
        for (
          let index = nextChunk++;
          index < chunks.length;
          index = nextChunk++
        ) {
          try {
            collected[index] = await extractChunk(
              {
                model,
                vendor: input.vendor,
                chunkIndex: index,
                chunkCount: chunks.length,
              },
              chunks[index],
            )
          } catch (error) {
            failures.push(toError(error))
          }
        }
      },
    )
    await Promise.all(workers)

    // One bad chunk must not discard the chunks that did parse. Only a
    // completely failed extraction surfaces as an error to the user.
    if (failures.length === chunks.length) {
      throw failures[0]
    }
    const candidates = dedupeCandidates(collected.flat())
    if (failures.length > 0) {
      log.warn("Some Nexus memory extraction chunks failed", {
        vendor: input.vendor,
        chunkCount: chunks.length,
        failedChunkCount: failures.length,
        candidateCount: candidates.length,
      })
    }
    return candidates
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
      finishReason: result.finishReason,
      usage: result.usage,
    }
  },
})
