/**
 * Graph Embeddings — direct Bedrock Runtime helper (Issue #1252)
 *
 * A thin, SELF-CONTAINED embedding helper for the context graph. It calls
 * Bedrock Runtime directly (amazon.titan-embed-text-v2 at 512 dimensions) using
 * the ambient IAM role (no new secret) and is deliberately DECOUPLED from the
 * repository-chunk embedding pipeline in `lib/ai-helpers.ts` (which is settings-
 * coupled to `EMBEDDING_MODEL_PROVIDER`/`EMBEDDING_MODEL_ID` and slated for a
 * separate rework). Do NOT route graph embeddings through `generateEmbedding()`.
 *
 * The model id is configurable via the `GRAPH_EMBEDDING_MODEL_ID` setting
 * (seeded by migration 115, default `amazon.titan-embed-text-v2:0`). The
 * `graph_nodes.embedding` pgvector column is fixed at 512 dimensions, so a model
 * with a different output dimension requires a re-embed backfill + column ALTER.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime"
import { getSetting } from "@/lib/settings-manager"
import { createLogger } from "@/lib/logger"

/** Fixed dimensionality of the `graph_nodes.embedding` column. */
export const GRAPH_EMBEDDING_DIMENSIONS = 512

/** Default Titan V2 model when the `GRAPH_EMBEDDING_MODEL_ID` setting is unset. */
export const DEFAULT_GRAPH_EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0"

/** Hard cap on input length (chars) — well under Titan's 8192-token limit. */
const MAX_INPUT_CHARS = 8000

/** Abort the Bedrock call if it does not return promptly; ER/search degrade gracefully. */
const EMBED_TIMEOUT_MS = 8000

// Singleton client, reused across warm invocations. Region resolves from the
// ambient environment (AWS_REGION is always set on ECS/Lambda); local dev falls
// back to us-east-1, where the call simply fails and the caller degrades.
let cachedClient: BedrockRuntimeClient | null = null

function getClient(): BedrockRuntimeClient {
  if (!cachedClient) {
    const region =
      process.env.AWS_REGION || process.env.BEDROCK_REGION || "us-east-1"
    cachedClient = new BedrockRuntimeClient({ region })
  }
  return cachedClient
}

/** Test seam — reset the memoized client (used by unit tests). */
export function __resetGraphEmbeddingClient(): void {
  cachedClient = null
}

/**
 * Resolve the graph embedding model id from settings, falling back to the
 * Titan V2 default. Non-throwing (getSetting returns null when unset).
 */
export async function getGraphEmbeddingModelId(): Promise<string> {
  const configured = await getSetting("GRAPH_EMBEDDING_MODEL_ID")
  return configured?.trim() || DEFAULT_GRAPH_EMBEDDING_MODEL_ID
}

/** Titan Text Embeddings V2 InvokeModel response shape. */
interface TitanEmbedResponse {
  embedding?: number[]
  inputTextTokenCount?: number
}

/**
 * Generate a 512-dim embedding for a single short text (node name + description).
 *
 * Throws on any failure (empty input, timeout, provider error, unexpected shape)
 * so the caller — the entity-resolution / semantic-search layer — can catch and
 * degrade gracefully. A capture is NEVER blocked by an embedding failure.
 */
export async function generateGraphEmbedding(text: string): Promise<number[]> {
  const log = createLogger({ module: "graph-embeddings" })
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error("generateGraphEmbedding: input text is empty")
  }

  const modelId = await getGraphEmbeddingModelId()
  const body = JSON.stringify({
    inputText: trimmed.slice(0, MAX_INPUT_CHARS),
    dimensions: GRAPH_EMBEDDING_DIMENSIONS,
    normalize: true,
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS)
  try {
    const response = await getClient().send(
      new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body,
      }),
      { abortSignal: controller.signal }
    )

    const parsed = JSON.parse(
      new TextDecoder().decode(response.body)
    ) as TitanEmbedResponse

    if (
      !Array.isArray(parsed.embedding) ||
      parsed.embedding.length !== GRAPH_EMBEDDING_DIMENSIONS
    ) {
      throw new Error(
        `generateGraphEmbedding: unexpected embedding shape from ${modelId} — expected ${GRAPH_EMBEDDING_DIMENSIONS} dims, got ${
          Array.isArray(parsed.embedding) ? parsed.embedding.length : "none"
        }`
      )
    }

    return parsed.embedding
  } catch (error) {
    log.warn("Graph embedding generation failed", {
      modelId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
