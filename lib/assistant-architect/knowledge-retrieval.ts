import { vectorSearch, hybridSearch } from "@/lib/repositories/search-service"
import { executeQuery } from "@/lib/db/drizzle-client"
import { assistantArchitects } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"
import { createLogger, generateRequestId } from "@/lib/logger"
import { encodingForModel } from "js-tiktoken"
// Import the requester builder from its concrete module (NOT the `@/lib/content`
// barrel), so this module — loaded by every assistant execution path — does not
// statically pull the content/embedding stack the barrel re-exports. This chain
// only reaches db + logger + SNS, never the embedding/vector-search modules.
import { requesterForUserId } from "@/lib/content/requester-from-auth"
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
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const log = createLogger({
    requestId: requestId || generateRequestId(),
    module: 'knowledge-retrieval'
  })

  if (!repositoryIds || repositoryIds.length === 0) {
    return []
  }

  // Normalize optional assistant owner sub to handle null/undefined/empty string consistently
  const ownerSub = assistantOwnerSub || null

  try {
    // First, verify user has access to all specified repositories
    // NOTE: Uses CAST(... AS integer[]) instead of ::int[] shorthand because
    // RDS Data API has parsing differences with PostgreSQL type cast shorthand. See Issue #583.
    const accessibleRepos = await executeQuery(
      (db) => db.execute(sql`
        SELECT DISTINCT r.id, r.name
        FROM knowledge_repositories r
        WHERE r.id = ANY(CAST(${repositoryIds} AS integer[]))
        -- Never RAG over system-managed repos (the Atrium retrieval index,
        -- #1056): their content is governed by per-object canView, not
        -- repository-level access. Atrium reads must go through retrievalService.
        AND (r.metadata->>'systemManaged') IS DISTINCT FROM 'true'
        AND (
          r.is_public = true
          OR r.owner_id = (SELECT id FROM users WHERE cognito_sub = ${userCognitoSub})
          OR (${ownerSub} IS NOT NULL
              AND r.owner_id = (SELECT id FROM users WHERE cognito_sub = ${ownerSub}))
          OR EXISTS (
            SELECT 1 FROM repository_access ra
            JOIN users u ON u.id = ra.user_id
            WHERE ra.repository_id = r.id AND u.cognito_sub = ${userCognitoSub}
          )
          OR EXISTS (
            SELECT 1 FROM repository_access ra
            JOIN user_roles ur ON ur.role_id = ra.role_id
            JOIN users u ON u.id = ur.user_id
            WHERE ra.repository_id = r.id AND u.cognito_sub = ${userCognitoSub}
          )
        )
      `),
      "getAccessibleRepositories"
    )

    // Runtime validation of query results
    // postgres.js returns result directly as array-like object (no .rows property)
    const rows = accessibleRepos as unknown as Array<Record<string, unknown>>
    const repos: Array<{ id: number; name: string }> = []
    for (const row of rows) {
      // Validate row structure
      if (typeof row === 'object' && row !== null && 'id' in row && 'name' in row) {
        const id = row.id
        const name = row.name
        if (typeof id === 'number' && typeof name === 'string') {
          repos.push({ id, name })
        } else {
          log.warn('Invalid row structure in repository query', { row })
        }
      } else {
        log.warn('Invalid row in repository query results', { row })
      }
    }

    if (repos.length !== repositoryIds.length) {
      const accessibleIds = repos.map(r => r.id)
      const inaccessibleIds = repositoryIds.filter(id => !accessibleIds.includes(id))
      log.warn('User attempted to access repositories without permission', {
        userCognitoSub,
        inaccessibleIds
      })
      // Continue with only accessible repositories
    }

    if (repos.length === 0) {
      return []
    }

    // Perform search across all accessible repositories
    const searchPromises = repos.map(async (repo) => {
      try {
        let results
        if (opts.searchType === "semantic") {
          results = await vectorSearch(promptContent, {
            repositoryId: repo.id,
            limit: opts.maxChunks,
            threshold: opts.similarityThreshold
          })
        } else {
          results = await hybridSearch(promptContent, {
            repositoryId: repo.id,
            limit: opts.maxChunks,
            threshold: opts.similarityThreshold,
            vectorWeight: opts.vectorWeight
          })
        }
        
        // Add repository info to results
        return results.map(result => ({
          ...result,
          repositoryId: repo.id,
          repositoryName: repo.name
        }))
      } catch (error) {
        log.error('Error searching repository', { repositoryId: repo.id, error })
        return []
      }
    })

    const allResults = await Promise.all(searchPromises)
    const flatResults = allResults.flat()

    // Sort by similarity score and take top results
    flatResults.sort((a, b) => b.similarity - a.similarity)
    const topResults = flatResults.slice(0, opts.maxChunks)

    // Apply token limit if specified
    if (opts.maxTokens) {
      const limitedResults: KnowledgeChunk[] = []
      let totalTokens = 0

      for (const chunk of topResults) {
        const chunkTokens = countTokens(chunk.content)
        if (totalTokens + chunkTokens <= opts.maxTokens) {
          limitedResults.push(chunk)
          totalTokens += chunkTokens
        } else {
          // If we can't fit the whole chunk, see if we can fit a truncated version
          const remainingTokens = opts.maxTokens - totalTokens
          if (remainingTokens > 100) { // Only include if we have reasonable space
            const truncatedContent = truncateToTokenLimit(chunk.content, remainingTokens)
            limitedResults.push({
              ...chunk,
              content: truncatedContent + "\n[... truncated for token limit]"
            })
          }
          break
        }
      }

      return limitedResults
    }

    return topResults
  } catch (error) {
    log.error('Error retrieving knowledge for prompt', { error })
    return []
  }
}

/**
 * Resolve the requester a SCHEDULED assistant run uses for Atrium content
 * RETRIEVAL (§16, Phase 6).
 *
 * Prefer the schedule's agent service identity (§25) when one was resolved. When
 * NONE is set — the common case, since nothing populates
 * `scheduled_executions.agent_identity_id` — fall back to the schedule OWNER's own
 * `user` requester. This is SAFE precisely because retrieval is READ-ONLY and
 * every hit is re-checked against the requester's `canView` inside
 * `searchForAssistant`: the owner can only ever retrieve content they may already
 * see. It is deliberately NOT the same as borrowing the owner's authority for a
 * WRITE (which the design forbids) — the caller resolves the write/execution
 * identity separately and leaves it untouched.
 *
 * Fails CLOSED: returns `null` (retrieval skipped) when there is no agent identity
 * AND the owner cannot be resolved (deleted/invalid user — `requesterForUserId`
 * returns null). Without this owner fallback, scheduled Atrium retrieval was
 * unreachable dead code (Epic #1059): `agentRequester` is always null in practice,
 * so `retrieveAtriumKnowledgeForPrompt` always fail-closed to nothing.
 */
export async function resolveScheduledAtriumRetrievalRequester(
  agentRequester: Requester | null,
  ownerUserId: number
): Promise<Requester | null> {
  if (agentRequester) return agentRequester
  return requesterForUserId(ownerUserId)
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