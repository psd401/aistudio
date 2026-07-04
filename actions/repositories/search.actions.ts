"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { type ActionState } from "@/types/actions-types"
import { 
  handleError,
  ErrorFactories,
  createSuccess
} from "@/lib/error-utils"
import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging
} from "@/lib/logger"
import { vectorSearch, keywordSearch, hybridSearch, SearchResult } from "@/lib/repositories/search-service"
import { getRepositoryById, isSystemManagedRepository } from "@/lib/db/drizzle/knowledge-repositories"

export interface SearchRepositoryParams {
  query: string
  repositoryId: number
  searchType?: 'vector' | 'keyword' | 'hybrid'
  limit?: number
  vectorWeight?: number
}

export async function searchRepository(
  params: SearchRepositoryParams
): Promise<ActionState<SearchResult[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("searchRepository")
  const log = createLogger({ requestId, action: "searchRepository" })
  
  try {
    const { query, repositoryId, searchType = 'hybrid', limit = 10, vectorWeight = 0.7 } = params
    
    log.info("Action started: Searching repository", {
      repositoryId,
      searchType,
      queryLength: query?.length,
      limit,
      vectorWeight: searchType === 'hybrid' ? vectorWeight : undefined
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized search attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("User authenticated", { userId: session.sub })

    // System-managed repositories (e.g. the Atrium retrieval index, #1056) hold
    // content governed by a finer-grained permission model than repository-level
    // access (every hit is filtered by `visibilityService.canView`). This generic
    // action enforces no repo-level authz, so it must refuse a system-managed id —
    // otherwise any authenticated user could search the shared index directly and
    // bypass `canView`. Mask as not-found so the id is not enumerable.
    const repository = await getRepositoryById(repositoryId)
    if (!repository || isSystemManagedRepository(repository)) {
      log.warn("Search denied - repository not found or system-managed", {
        repositoryId,
      })
      return {
        isSuccess: false,
        message: "Repository not found",
      }
    }

    if (!query || query.trim().length === 0) {
      log.warn("Empty search query provided")
      return {
        isSuccess: false,
        message: "Please enter a search query",
      }
    }

    let results: SearchResult[]
    
    log.info("Executing search", {
      searchType,
      repositoryId,
      queryPreview: query.substring(0, 50) // First 50 chars of query
    })

    switch (searchType) {
      case 'vector':
        log.debug("Performing vector search")
        results = await vectorSearch(query, { repositoryId, limit })
        break
      case 'keyword':
        log.debug("Performing keyword search")
        results = await keywordSearch(query, { repositoryId, limit })
        break
      case 'hybrid':
      default:
        log.debug("Performing hybrid search", { vectorWeight })
        results = await hybridSearch(query, { repositoryId, limit, vectorWeight })
        break
    }

    log.info("Search completed successfully", {
      repositoryId,
      searchType,
      resultCount: results.length,
      limit
    })
    
    timer({ 
      status: "success", 
      resultCount: results.length,
      searchType 
    })

    return createSuccess(results, `Found ${results.length} results`)
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to search repository. Please try again or contact support.", {
      context: "searchRepository",
      requestId,
      operation: "searchRepository",
      metadata: sanitizeForLogging({
        repositoryId: params.repositoryId,
        searchType: params.searchType,
        limit: params.limit
      }) as Record<string, unknown>
    })
  }
}