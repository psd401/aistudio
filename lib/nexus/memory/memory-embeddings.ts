/**
 * Nexus memory embeddings — direct Bedrock Runtime helper (Issue #1407).
 *
 * This is deliberately decoupled from the repository EMBEDDING_MODEL_* pipeline
 * and mirrors the context-graph embedding helper. The database column is fixed
 * at 512 dimensions; changing that requires a backfill plus schema migration.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime"
import { createLogger } from "@/lib/logger"
import { getSetting } from "@/lib/settings-manager"

export const MEMORY_EMBEDDING_DIMENSIONS = 512
export const DEFAULT_MEMORY_EMBEDDING_MODEL_ID =
  "amazon.titan-embed-text-v2:0"

const MAX_INPUT_CHARS = 8_000
const EMBED_TIMEOUT_MS = 8_000

let cachedClient: BedrockRuntimeClient | null = null

function getClient(): BedrockRuntimeClient {
  if (!cachedClient) {
    const region =
      process.env.AWS_REGION || process.env.BEDROCK_REGION || "us-east-1"
    cachedClient = new BedrockRuntimeClient({ region })
  }
  return cachedClient
}

/** Test seam for the warm-process Bedrock client. */
export function __resetMemoryEmbeddingClient(): void {
  cachedClient = null
}

export async function getMemoryEmbeddingModelId(): Promise<string> {
  const configured = await getSetting("MEMORY_EMBEDDING_MODEL_ID")
  return configured?.trim() || DEFAULT_MEMORY_EMBEDDING_MODEL_ID
}

async function assertConfiguredDimensions(): Promise<void> {
  const configured = await getSetting("MEMORY_EMBEDDING_DIMENSIONS")
  if (configured === null || configured.trim() === "") return
  if (Number(configured) !== MEMORY_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Nexus memory embedding dimensions must remain ${MEMORY_EMBEDDING_DIMENSIONS}; received ${configured}`,
    )
  }
}

interface TitanEmbedResponse {
  embedding?: number[]
}

export async function generateMemoryEmbedding(text: string): Promise<number[]> {
  const log = createLogger({ module: "nexus-memory-embeddings" })
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error("generateMemoryEmbedding: input text is empty")
  }

  await assertConfiguredDimensions()
  const modelId = await getMemoryEmbeddingModelId()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS)

  try {
    const response = await getClient().send(
      new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          inputText: trimmed.slice(0, MAX_INPUT_CHARS),
          dimensions: MEMORY_EMBEDDING_DIMENSIONS,
          normalize: true,
        }),
      }),
      { abortSignal: controller.signal },
    )
    const parsed = JSON.parse(
      new TextDecoder().decode(response.body),
    ) as TitanEmbedResponse | null

    if (
      !parsed ||
      !Array.isArray(parsed.embedding) ||
      parsed.embedding.length !== MEMORY_EMBEDDING_DIMENSIONS ||
      parsed.embedding.some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      )
    ) {
      const actual =
        parsed && Array.isArray(parsed.embedding)
          ? parsed.embedding.length
          : "none"
      throw new Error(
        `generateMemoryEmbedding: expected ${MEMORY_EMBEDDING_DIMENSIONS} dimensions from ${modelId}, received ${actual}`,
      )
    }
    return parsed.embedding
  } catch (error) {
    log.warn("Nexus memory embedding generation failed", {
      modelId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
