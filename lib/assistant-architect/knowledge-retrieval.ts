import { retrieveRepositoryContent } from "@/lib/repositories/retrieval-v2/service"
import { vectorSearch, hybridSearch } from "@/lib/repositories/search-service"
import { getAccessibleRepositoriesByCognitoSub } from "@/lib/db/drizzle"
import {
  getContentPlatformConfig,
  isContentReadV2Active,
} from "@/lib/repositories/content-platform/config"
import { executeQuery } from "@/lib/db/drizzle-client"
import { assistantArchitects } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { createLogger, generateRequestId } from "@/lib/logger"
import { encodingForModel } from "js-tiktoken"
import type { Requester } from "@/lib/content/types"
import type { RetrievalHit } from "@/lib/content/retrieval-service"

interface KnowledgeChunk {
  chunkId: number
  itemId: number
  itemName: string
  content: string
  similarity: number
  repositoryId: number
  repositoryName: string
}

interface KnowledgeRetrievalOptions {
  maxChunks?: number
  maxTokens?: number
  similarityThreshold?: number
  searchType?: "semantic" | "hybrid"
  vectorWeight?: number
}

const DEFAULT_OPTIONS: KnowledgeRetrievalOptions = {
  maxChunks: 10,
  maxTokens: 4000,
  similarityThreshold: 0.7,
  searchType: "hybrid",
  vectorWeight: 0.8
}

// Initialize tokenizer for GPT models
// Using cl100k_base which is used by gpt-4, gpt-3.5-turbo, text-embedding-ada-002
let tokenizer: ReturnType<typeof encodingForModel> | null = null

/**
 * Count tokens in a string using proper tokenization
 * Falls back to approximation if tokenizer fails
 */
function countTokens(text: string, requestId?: string): number {
  if (!text) return 0

  try {
    // Initialize tokenizer lazily to avoid startup cost
    if (!tokenizer) {
      tokenizer = encodingForModel("gpt-3.5-turbo")
    }

    const tokens = tokenizer.encode(text)
    return tokens.length
  } catch (error) {
    // Fall back to approximation if tokenization fails
    const log = createLogger({ requestId: requestId || generateRequestId(), module: 'knowledge-retrieval' })
    log.warn('Token counting failed, using approximation', { error })
    return Math.ceil(text.length / 4)
  }
}

function applyKnowledgeTokenBudget(
  chunks: KnowledgeChunk[],
  maxTokens: number,
  requestId?: string
): KnowledgeChunk[] {
  const limited: KnowledgeChunk[] = []
  let totalTokens = 0

  for (const chunk of chunks) {
    const chunkTokens = countTokens(chunk.content, requestId)
    if (totalTokens + chunkTokens <= maxTokens) {
      limited.push(chunk)
      totalTokens += chunkTokens
      continue
    }

    const remainingTokens = maxTokens - totalTokens
    if (remainingTokens > 100) {
      limited.push({
        ...chunk,
        content:
          truncateToTokenLimit(chunk.content, remainingTokens) +
          "\n[... truncated for token limit]",
      })
    }
    break
  }

  return limited
}

interface LegacyKnowledgeRequest {
  promptContent: string
  repositoryIds: number[]
  userCognitoSub: string
  opts: Required<KnowledgeRetrievalOptions>
  requestId?: string
  log: ReturnType<typeof createLogger>
}

function resolveKnowledgeOptions(
  options: KnowledgeRetrievalOptions
): Required<KnowledgeRetrievalOptions> {
  return {
    maxChunks: options.maxChunks ?? DEFAULT_OPTIONS.maxChunks ?? 10,
    maxTokens: options.maxTokens ?? DEFAULT_OPTIONS.maxTokens ?? 4000,
    similarityThreshold:
      options.similarityThreshold ?? DEFAULT_OPTIONS.similarityThreshold ?? 0.7,
    searchType: options.searchType ?? DEFAULT_OPTIONS.searchType ?? "hybrid",
    vectorWeight: options.vectorWeight ?? DEFAULT_OPTIONS.vectorWeight ?? 0.8,
  }
}

async function retrieveLegacyRepositoryKnowledge({
  promptContent,
  repositoryIds,
  userCognitoSub,
  opts,
  requestId,
  log,
}: LegacyKnowledgeRequest): Promise<KnowledgeChunk[]> {
  // The compatibility path deliberately checks only the executing user. An
  // assistant owner's repository access configures bindings but must never
  // elevate another user's access at execution time.
  const repositories = (
    await getAccessibleRepositoriesByCognitoSub(repositoryIds, userCognitoSub)
  ).filter((repository) => repository.isAccessible)

  const perRepositoryResults = await Promise.all(
    repositories.map(async (repository): Promise<KnowledgeChunk[]> => {
      try {
        const results =
          opts.searchType === "semantic"
            ? await vectorSearch(promptContent, {
                repositoryId: repository.id,
                limit: opts.maxChunks,
                threshold: opts.similarityThreshold,
              })
            : await hybridSearch(promptContent, {
                repositoryId: repository.id,
                limit: opts.maxChunks,
                threshold: opts.similarityThreshold,
                vectorWeight: opts.vectorWeight,
              })

        return results.map((result) => ({
          chunkId: result.chunkId,
          itemId: result.itemId,
          itemName: result.itemName,
          content: result.content,
          similarity: result.similarity,
          repositoryId: repository.id,
          repositoryName: repository.name,
        }))
      } catch (error) {
        log.error("Error searching legacy repository", {
          repositoryId: repository.id,
          error,
        })
        return []
      }
    })
  )

  const topResults = perRepositoryResults
    .flat()
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, opts.maxChunks)

  return applyKnowledgeTokenBudget(topResults, opts.maxTokens, requestId)
}

/**
 * Retrieve relevant knowledge chunks from specified repositories
 */
export async function retrieveKnowledgeForPrompt(
  promptContent: string,
  repositoryIds: number[],
  userCognitoSub: string,
  assistantOwnerSub?: string,
  options: KnowledgeRetrievalOptions = {},
  requestId?: string
): Promise<KnowledgeChunk[]> {
  const opts = resolveKnowledgeOptions(options)
  const log = createLogger({
    requestId: requestId || generateRequestId(),
    module: 'knowledge-retrieval'
  })

  if (!repositoryIds || repositoryIds.length === 0) {
    return []
  }
  // Assistant ownership configures bindings; it never grants the executing
  // user data access. Both retrieval paths revalidate the current user.
  void assistantOwnerSub
  try {
    const config = await getContentPlatformConfig()
    if (!isContentReadV2Active(config)) {
      return retrieveLegacyRepositoryKnowledge({
        promptContent,
        repositoryIds,
        userCognitoSub,
        opts,
        requestId,
        log,
      })
    }

    const response = await retrieveRepositoryContent({
      query: promptContent,
      repositoryIds,
      userCognitoSub,
      mode: opts.searchType === "semantic" ? "vector" : "hybrid",
      limit: opts.maxChunks,
      threshold: opts.similarityThreshold,
      tokenBudget: opts.maxTokens,
      denseWeight: opts.vectorWeight,
    })
    return response.results.map((result) => ({
      chunkId: result.chunkId,
      itemId: result.itemId,
      itemName: result.itemName,
      content:
        result.context.length > 0
          ? result.context
              .map((segment) =>
                [segment.contextPrefix, segment.content]
                  .filter(Boolean)
                  .join("\n")
              )
              .join("\n\n")
          : result.content,
      similarity: result.similarity,
      repositoryId: result.repositoryId,
      repositoryName: result.repositoryName,
    }))
  } catch (error) {
    log.error('Error retrieving knowledge for prompt', { error })
    return []
  }
}

/** Options for Atrium content retrieval (same caps as the repository path). */
interface AtriumKnowledgeOptions {
  maxChunks?: number
  maxTokens?: number
  similarityThreshold?: number
}

/**
 * Retrieve permission-aware Atrium content context for an assistant prompt
 * (Atrium Phase 6, Issue #1056 — "content as context", Epic #1059).
 *
 * OFF BY DEFAULT: only assistants whose `assistant_architects.retrieval_scope`
 * is set (migration 094) retrieve Atrium content. A null/unset scope skips the
 * search entirely — `retrievalService.searchForAssistant` is never called — so
 * assistants that predate Phase 6 behave exactly as before.
 *
 * FAIL CLOSED: a missing requester (e.g. a scheduled run that resolved no
 * service identity) skips retrieval. Atrium hits are always bounded by the
 * ACTUAL caller's `canView` (enforced per hit inside `searchForAssistant`) —
 * never a borrowed or implicit authority.
 *
 * Mirrors `retrieveKnowledgeForPrompt`'s failure posture: any error logs and
 * returns [] so retrieval can never fail an execution. The token budget is the
 * same algorithm the repository path applies (whole chunks until the cap, one
 * truncated tail chunk when ≥100 tokens remain).
 *
 * `retrievalService` is imported lazily so this module (loaded by every
 * assistant execution path) does not statically pull the content/embedding
 * stack when Atrium retrieval never runs.
 */
export async function retrieveAtriumKnowledgeForPrompt(
  requester: Requester | null | undefined,
  assistantId: number,
  promptContent: string,
  options: AtriumKnowledgeOptions = {},
  requestId?: string
): Promise<RetrievalHit[]> {
  const log = createLogger({
    requestId: requestId || generateRequestId(),
    module: 'knowledge-retrieval'
  })

  // No derivable caller identity -> no Atrium context (fail closed to nothing).
  if (!requester) return []

  try {
    // Gate on the stored scope BEFORE searching: null/unset = retrieval off.
    const rows = await executeQuery(
      (db) =>
        db
          .select({ retrievalScope: assistantArchitects.retrievalScope })
          .from(assistantArchitects)
          .where(eq(assistantArchitects.id, assistantId))
          .limit(1),
      "atrium.assistantRetrievalScopeGate"
    )
    if (!rows[0] || rows[0].retrievalScope == null) return []

    const { retrievalService } = await import("@/lib/content/retrieval-service")
    const hits = await retrievalService.searchForAssistant(
      requester,
      assistantId,
      promptContent,
      {
        limit: options.maxChunks ?? DEFAULT_OPTIONS.maxChunks,
        threshold: options.similarityThreshold
      }
    )
    if (hits.length === 0) return []

    // Apply the same token budget the repository path enforces.
    const maxTokens = options.maxTokens ?? DEFAULT_OPTIONS.maxTokens ?? 4000
    const limited: RetrievalHit[] = []
    let totalTokens = 0
    for (const hit of hits) {
      const hitTokens = countTokens(hit.content, requestId)
      if (totalTokens + hitTokens <= maxTokens) {
        limited.push(hit)
        totalTokens += hitTokens
      } else {
        const remainingTokens = maxTokens - totalTokens
        if (remainingTokens > 100) {
          limited.push({
            ...hit,
            content:
              truncateToTokenLimit(hit.content, remainingTokens) +
              "\n[... truncated for token limit]"
          })
        }
        break
      }
    }
    return limited
  } catch (error) {
    log.error('Error retrieving Atrium knowledge for prompt', { assistantId, error })
    return []
  }
}

/**
 * Format Atrium retrieval hits into a clearly-labelled context block. Mirrors
 * `formatKnowledgeContext`'s structure but with distinct `atrium:<slug>` source
 * labels so the model (and anyone auditing a transcript) can tell Atrium
 * content apart from repository knowledge.
 */
export function formatAtriumKnowledgeContext(hits: RetrievalHit[]): string {
  if (hits.length === 0) {
    return ""
  }

  const sections = hits.map((hit, index) => {
    return `## Atrium Source ${index + 1}: ${hit.title} (atrium:${hit.slug})
Relevance Score: ${(hit.similarity * 100).toFixed(1)}%

${hit.content}`
  })

  return `# Atrium Content Context

The following published content was retrieved from the Atrium content workspace based on relevance to the prompt:

${sections.join('\n\n---\n\n')}

---
End of Atrium content context.`
}

/**
 * Format retrieved knowledge chunks into a context string
 */
export function formatKnowledgeContext(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) {
    return ""
  }

  const sections = chunks.map((chunk, index) => {
    return `## Knowledge Source ${index + 1}: ${chunk.itemName} (${chunk.repositoryName})
Relevance Score: ${(chunk.similarity * 100).toFixed(1)}%

${chunk.content}`
  })

  return `# Retrieved Knowledge Context

The following information was retrieved from your knowledge repositories based on relevance to the prompt:

${sections.join('\n\n---\n\n')}

---
End of retrieved knowledge context.`
}

/**
 * Truncate text to token limit
 */
function truncateToTokenLimit(text: string, maxTokens: number): string {
  const currentTokens = countTokens(text)
  if (currentTokens <= maxTokens) {
    return text
  }
  
  // Binary search to find the right truncation point
  let left = 0
  let right = text.length
  let bestFit = text
  
  while (left < right) {
    const mid = Math.floor((left + right) / 2)
    const candidate = text.slice(0, mid)
    const tokens = countTokens(candidate)
    
    if (tokens <= maxTokens) {
      bestFit = candidate
      left = mid + 1
    } else {
      right = mid
    }
  }
  
  // Try to break at a sentence or word boundary
  const lastPeriod = bestFit.lastIndexOf('.')
  const lastNewline = bestFit.lastIndexOf('\n')
  const lastSpace = bestFit.lastIndexOf(' ')
  
  const breakPoint = Math.max(lastPeriod, lastNewline)
  if (breakPoint > bestFit.length * 0.8) {
    return bestFit.slice(0, breakPoint + 1)
  }
  
  if (lastSpace > bestFit.length * 0.8) {
    return bestFit.slice(0, lastSpace)
  }
  
  return bestFit
}

/**
 * Clean up tokenizer resources
 * Call this when done with token counting to free memory
 */
export function cleanupTokenizer(): void {
  if (tokenizer) {
    // js-tiktoken doesn't have a free() method, just clear the reference
    tokenizer = null
  }
}
