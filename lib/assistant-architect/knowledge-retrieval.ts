import { vectorSearch, hybridSearch } from "@/lib/repositories/search-service"
import { executeQuery } from "@/lib/db/drizzle-client"
import { sql } from "drizzle-orm"
import { createLogger, generateRequestId } from "@/lib/logger"
import { encodingForModel } from "js-tiktoken"

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

  try {
    // First, verify user has access to all specified repositories
    const accessibleRepos = await executeQuery(
      (db) => db.execute(sql`
        SELECT DISTINCT r.id, r.name
        FROM knowledge_repositories r
        WHERE r.id = ANY(${repositoryIds}::int[])
        AND (
          r.is_public = true
          OR r.owner_id = (SELECT id FROM users WHERE cognito_sub = ${userCognitoSub})
          OR (${assistantOwnerSub !== undefined ? sql`${assistantOwnerSub}` : sql`NULL`} IS NOT NULL
              AND r.owner_id = (SELECT id FROM users WHERE cognito_sub = ${assistantOwnerSub || null}))
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
    const repos: Array<{ id: number; name: string }> = []
    for (const row of accessibleRepos.rows) {
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