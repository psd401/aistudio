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
import { hasCapabilityAccess } from "@/utils/roles"
import { assertRepositoryReadAccess } from "@/lib/repositories/repository-access-guard"

export interface SearchRepositoryParams {
  query: string
  repositoryId: number
  searchType?: 'vector' | 'keyword' | 'hybrid'
  limit?: number
  vectorWeight?: number
}

// Dispatch to the requested search mode with pre-clamped bounds (not exported:
// a "use server" file may only export async server actions).
async function dispatchSearch(
  searchType: 'vector' | 'keyword' | 'hybrid',
  query: string,
  repositoryId: number,
  limit: number,
  vectorWeight: number
): Promise<SearchResult[]> {
  switch (searchType) {
    case 'vector':
      return vectorSearch(query, { repositoryId, limit })
    case 'keyword':
      return keywordSearch(query, { repositoryId, limit })
    case 'hybrid':
    default:
      return hybridSearch(query, { repositoryId, limit, vectorWeight })
  }
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

    // Capability gate — every other repository action requires this; search was
    // the outlier that only checked for a session (REV-COR-062 / REV-SEC-081).
    if (!(await hasCapabilityAccess("knowledge-repositories"))) {
      log.warn("Search denied - missing knowledge-repositories capability", { userId: session.sub })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // repositoryId must be a positive integer. A falsy id (0, or omitted in a
    // hand-crafted server-action POST) would otherwise reach the search-service's
    // unfiltered "search ALL repositories" branch and leak every user's content.
    if (!Number.isInteger(repositoryId) || repositoryId <= 0) {
      log.warn("Invalid repositoryId in search", { repositoryId })
      return { isSuccess: false, message: "A valid repositoryId is required" }
    }

    // Per-repository authorization: the caller must be able to access this
    // repository (public / owner / `repository_access` grant) before searching
    // its chunks. Closes the IDOR where ANY authenticated user could search a
    // private repo by id. Also excludes system-managed repos (the Atrium index,
    // #1056) — the access model filters them, so this single check prevents a
    // direct search of the shared index that would bypass `canView`. Throws
    // `dbRecordNotFound` (existence-masked); handled by the outer catch.
    await assertRepositoryReadAccess(repositoryId, session.sub)

    // Clamp caller-supplied bounds so a POST can't request unbounded rows / weights (REV-SEC-081).
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50)
    const safeVectorWeight = Math.min(Math.max(0, vectorWeight), 1)

    if (!query || query.trim().length === 0) {
      log.warn("Empty search query provided")
      return {
        isSuccess: false,
        message: "Please enter a search query",
      }
    }

    log.info("Executing search", {
      searchType,
      repositoryId,
      queryPreview: query.substring(0, 50) // First 50 chars of query
    })

    const results = await dispatchSearch(searchType, query, repositoryId, safeLimit, safeVectorWeight)

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