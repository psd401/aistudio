import "server-only"

import { createLogger } from "@/lib/logger"
import {
  hybridSearch,
  keywordSearch,
  type SearchResult,
  vectorSearch,
} from "@/lib/repositories/search-service"
import type { ContentPlatformConfig } from "@/lib/repositories/content-platform/config"
import { recordRepositoryRetrievalShadow } from "@/lib/repositories/content-platform/retrieval-shadow"
import { retrieveRepositoryContent } from "@/lib/repositories/retrieval-v2/service"
import type { RetrievalResult } from "@/lib/repositories/retrieval-v2/types"

export interface SearchDispatchOptions {
  searchType: "vector" | "keyword" | "hybrid"
  query: string
  repositoryId: number
  limit: number
  vectorWeight: number
  canonicalOnly: boolean
}

type RetrievalDiagnostics = Awaited<
  ReturnType<typeof retrieveRepositoryContent>
>["diagnostics"]

export interface ExecuteSearchOptions extends SearchDispatchOptions {
  userCognitoSub: string
  contentConfig: ContentPlatformConfig
  log: ReturnType<typeof createLogger>
}

export type RetrievalShadowExecutionOutcome =
  | { status: "recorded" }
  | { status: "skipped"; reason: string }

export interface ExecuteSearchResult {
  results: SearchResult[]
  diagnostics?: RetrievalDiagnostics
  shadowOutcome?: RetrievalShadowExecutionOutcome
}

async function dispatchSearch({
  searchType,
  query,
  repositoryId,
  limit,
  vectorWeight,
  canonicalOnly,
}: SearchDispatchOptions): Promise<SearchResult[]> {
  const commonOptions = { repositoryId, limit, canonicalOnly }
  switch (searchType) {
    case "vector":
      return vectorSearch(query, commonOptions)
    case "keyword":
      return keywordSearch(query, commonOptions)
    case "hybrid":
    default:
      return hybridSearch(query, { ...commonOptions, vectorWeight })
  }
}

/**
 * Shared Repository Manager search execution path. The normal search action and
 * the bounded administrator sample action both enter here so shadow recording
 * retains one implementation and remains fail-open.
 */
export async function executeSearch(
  options: ExecuteSearchOptions,
): Promise<ExecuteSearchResult> {
  if (options.canonicalOnly) {
    const retrieval = await retrieveRepositoryContent({
      query: options.query,
      repositoryIds: [options.repositoryId],
      userCognitoSub: options.userCognitoSub,
      mode: options.searchType,
      limit: options.limit,
      denseWeight: options.vectorWeight,
      includeLegacyCompatibility: false,
    })
    return {
      results: retrieval.results.map(toLegacySearchResult),
      diagnostics: retrieval.diagnostics,
    }
  }

  const legacyStartedAt = Date.now()
  const results = await dispatchSearch(options)
  const shadowOutcome = await recordRetrievalShadowIfEnabled(
    options,
    results,
    Date.now() - legacyStartedAt,
  )
  return { results, shadowOutcome }
}

async function recordRetrievalShadowIfEnabled(
  options: ExecuteSearchOptions,
  legacyResults: SearchResult[],
  legacyDurationMs: number,
): Promise<RetrievalShadowExecutionOutcome> {
  const { contentConfig } = options
  if (
    !contentConfig.enabled ||
    !contentConfig.readV2Enabled ||
    !contentConfig.retrievalShadowEnabled
  ) {
    return {
      status: "skipped",
      reason: "Retrieval shadow recording is disabled",
    }
  }

  const canonicalStartedAt = Date.now()
  try {
    const canonicalShadow = await retrieveRepositoryContent({
      query: options.query,
      repositoryIds: [options.repositoryId],
      userCognitoSub: options.userCognitoSub,
      mode: options.searchType,
      limit: options.limit,
      denseWeight: options.vectorWeight,
      includeLegacyCompatibility: false,
    })
    await recordRepositoryRetrievalShadow({
      repositoryId: options.repositoryId,
      product: "repository_manager",
      searchMode: options.searchType,
      legacyItemIds: legacyResults.map((result) => result.itemId),
      canonicalItemIds: canonicalShadow.results.map((result) => result.itemId),
      legacyDurationMs,
      canonicalDurationMs: Date.now() - canonicalStartedAt,
    })
    return { status: "recorded" }
  } catch (shadowError) {
    options.log.warn(
      "Canonical retrieval shadow failed without affecting legacy search",
      {
        error:
          shadowError instanceof Error
            ? shadowError.message
            : String(shadowError),
      },
    )
    return {
      status: "skipped",
      reason: "Canonical retrieval shadow failed; legacy results were served",
    }
  }
}

function toLegacySearchResult(result: RetrievalResult): SearchResult {
  return {
    chunkId: result.chunkId,
    itemId: result.itemId,
    itemName: result.itemName,
    content: result.content,
    similarity: result.similarity,
    chunkIndex: result.chunkIndex,
    metadata: result.metadata,
    citation: {
      itemStableId: result.itemStableId,
      itemVersionId: result.itemVersionId,
      versionNumber: result.versionNumber,
      sourceLocator: result.sourceLocator,
    },
  }
}
