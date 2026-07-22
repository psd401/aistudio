import { tool } from 'ai';
import { z } from 'zod';
import { retrieveRepositoryContent } from '@/lib/repositories/retrieval-v2/service';
import {
  hybridSearch,
  keywordSearch,
  vectorSearch,
} from '@/lib/repositories/search-service';
import type { SearchCitation } from '@/lib/repositories/search-service';
import type {
  RetrievalCitation,
  RetrievalContextSegment,
  RetrievalMode,
} from '@/lib/repositories/retrieval-v2/types';
import {
  getContentPlatformConfig,
  isContentReadV2Active,
} from '@/lib/repositories/content-platform/config';
import { createLogger } from '@/lib/logger';
import { getAccessibleRepositoriesByCognitoSub } from '@/lib/db/drizzle';

/**
 * Repository Search Tools for AI Assistant
 *
 * These tools allow LLMs to dynamically search repository knowledge bases during execution.
 * Used in conjunction with automatic context injection for comprehensive knowledge access.
 *
 * SECURITY: All tools perform authorization checks before searching to prevent
 * unauthorized access to private repositories.
 */

interface RepositoryToolOptions {
  repositoryIds: number[];
  userCognitoSub: string;
  assistantOwnerSub?: string;
}

interface RepositoryToolSearchHit {
  content: string;
  itemName: string;
  similarity: number;
  chunkIndex: number;
  citation?: RetrievalCitation | SearchCitation;
  context?: RetrievalContextSegment[];
}

interface RepositoryToolSearchRequest {
  query: string;
  repositoryIds: number[];
  userCognitoSub: string;
  mode: RetrievalMode;
  limit: number;
  threshold?: number;
  vectorWeight?: number;
}

/**
 * Verify user has access to specified repositories
 * @throws Error if user has no access to any repositories
 */
async function verifyRepositoryAccess(
  repositoryIds: number[],
  userCognitoSub: string
): Promise<number[]> {
  const repositories = await getAccessibleRepositoriesByCognitoSub(
    repositoryIds,
    userCognitoSub
  );

  return repositories
    .filter(repo => repo.isAccessible)
    .map(repo => repo.id);
}

async function searchAccessibleRepositories(
  request: RepositoryToolSearchRequest
): Promise<RepositoryToolSearchHit[]> {
  const config = await getContentPlatformConfig();
  if (isContentReadV2Active(config)) {
    const retrieval = await retrieveRepositoryContent({
      query: request.query,
      repositoryIds: request.repositoryIds,
      userCognitoSub: request.userCognitoSub,
      mode: request.mode,
      limit: request.limit,
      ...(request.threshold == null ? {} : { threshold: request.threshold }),
      ...(request.vectorWeight == null
        ? {}
        : { denseWeight: request.vectorWeight }),
    });
    return retrieval.results.map((result) => ({
      content: result.content,
      itemName: result.itemName,
      similarity: result.similarity,
      chunkIndex: result.chunkIndex,
      citation: result.citations[0],
      context: result.context,
    }));
  }

  const perRepositoryResults = await Promise.all(
    request.repositoryIds.map(async (repositoryId) => {
      const options = {
        repositoryId,
        limit: request.limit,
        ...(request.threshold == null ? {} : { threshold: request.threshold }),
      };
      if (request.mode === 'vector') {
        return vectorSearch(request.query, options);
      }
      if (request.mode === 'keyword') {
        return keywordSearch(request.query, options);
      }
      return hybridSearch(request.query, {
        ...options,
        vectorWeight: request.vectorWeight,
      });
    })
  );

  return perRepositoryResults
    .flat()
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, request.limit);
}

/**
 * Create vector search tool for semantic similarity search
 */
export function createVectorSearchTool(options: RepositoryToolOptions): unknown {
  const { repositoryIds, userCognitoSub } = options;
  const log = createLogger({ module: 'repository-tools', tool: 'vectorSearch' });

  return tool({
    description: `Search repository knowledge base using semantic vector similarity. Best for finding conceptually related content even if exact keywords don't match. Searches repositories: ${repositoryIds.join(', ')}`,
    inputSchema: z.object({
      query: z.string().describe('The search query to find relevant content'),
      limit: z.number().min(1).max(100).optional().default(5).describe('Maximum number of results to return (1-100, default: 5)'),
      threshold: z.number().min(0).max(1).optional().default(0.7).describe('Similarity threshold 0-1 (default: 0.7)')
    }),
    execute: async ({ query, limit, threshold }: { query: string; limit?: number; threshold?: number }) => {
      log.info('Vector search executed', { query, limit, threshold, repositoryIds });

      try {
        // SECURITY: Verify user has access to repositories
        const accessibleRepoIds = await verifyRepositoryAccess(repositoryIds, userCognitoSub);

        if (accessibleRepoIds.length === 0) {
          log.warn('No accessible repositories for vector search', { userCognitoSub, requestedRepos: repositoryIds });
          return {
            success: false,
            error: 'No access to specified repositories',
            query
          };
        }

        const topResults = await searchAccessibleRepositories({
          query,
          repositoryIds: accessibleRepoIds,
          userCognitoSub,
          mode: 'vector',
          limit: limit ?? 5,
          threshold: threshold ?? 0.7,
        });

        if (topResults.length === 0) {
          return {
            success: true,
            results: [],
            message: `No results found for query: "${query}"`
          };
        }

        // Format results for LLM consumption
        const formattedResults = topResults.map((result, idx) => ({
          rank: idx + 1,
          content: result.content,
          source: result.itemName,
          similarity: Math.round(result.similarity * 100) / 100,
          chunkIndex: result.chunkIndex,
          citation: result.citation,
          context: result.context,
        }));

        log.info('Vector search completed', { resultCount: formattedResults.length });

        return {
          success: true,
          resultCount: formattedResults.length,
          query,
          searchType: 'vector',
          results: formattedResults
        };
      } catch (error) {
        log.error('Vector search failed', { error, query });
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Search failed',
          query
        };
      }
    }
  }) as unknown;
}

/**
 * Create keyword search tool for exact text matching
 */
export function createKeywordSearchTool(options: RepositoryToolOptions): unknown {
  const { repositoryIds, userCognitoSub } = options;
  const log = createLogger({ module: 'repository-tools', tool: 'keywordSearch' });

  return tool({
    description: `Search repository knowledge base using exact keyword matching. Best for finding specific terms, phrases, or technical names. Searches repositories: ${repositoryIds.join(', ')}`,
    inputSchema: z.object({
      query: z.string().describe('The keyword or phrase to search for'),
      limit: z.number().min(1).max(100).optional().default(5).describe('Maximum number of results to return (1-100, default: 5)')
    }),
    execute: async ({ query, limit }: { query: string; limit?: number }) => {
      log.info('Keyword search executed', { query, limit, repositoryIds });

      try {
        // SECURITY: Verify user has access to repositories
        const accessibleRepoIds = await verifyRepositoryAccess(repositoryIds, userCognitoSub);

        if (accessibleRepoIds.length === 0) {
          log.warn('No accessible repositories for keyword search', { userCognitoSub, requestedRepos: repositoryIds });
          return {
            success: false,
            error: 'No access to specified repositories',
            query
          };
        }

        const topResults = await searchAccessibleRepositories({
          query,
          repositoryIds: accessibleRepoIds,
          userCognitoSub,
          mode: 'keyword',
          limit: limit ?? 5,
        });

        if (topResults.length === 0) {
          return {
            success: true,
            results: [],
            message: `No results found for keyword: "${query}"`
          };
        }

        // Format results for LLM consumption
        const formattedResults = topResults.map((result, idx) => ({
          rank: idx + 1,
          content: result.content,
          source: result.itemName,
          relevance: Math.round(result.similarity * 100) / 100,
          chunkIndex: result.chunkIndex,
          citation: result.citation,
          context: result.context,
        }));

        log.info('Keyword search completed', { resultCount: formattedResults.length });

        return {
          success: true,
          resultCount: formattedResults.length,
          query,
          searchType: 'keyword',
          results: formattedResults
        };
      } catch (error) {
        log.error('Keyword search failed', { error, query });
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Search failed',
          query
        };
      }
    }
  }) as unknown;
}

/**
 * Create hybrid search tool combining vector and keyword search
 */
export function createHybridSearchTool(options: RepositoryToolOptions): unknown {
  const { repositoryIds, userCognitoSub } = options;
  const log = createLogger({ module: 'repository-tools', tool: 'hybridSearch' });

  return tool({
    description: `Search repository knowledge base using combined semantic and keyword matching. Best for comprehensive search that balances conceptual similarity with exact matches. Searches repositories: ${repositoryIds.join(', ')}`,
    inputSchema: z.object({
      query: z.string().describe('The search query'),
      limit: z.number().min(1).max(100).optional().default(5).describe('Maximum number of results to return (1-100, default: 5)'),
      threshold: z.number().min(0).max(1).optional().default(0.7).describe('Similarity threshold 0-1 (default: 0.7)'),
      vectorWeight: z.number().min(0).max(1).optional().default(0.7).describe('Weight for vector search 0-1 (default: 0.7, keyword gets remainder)')
    }),
    execute: async ({ query, limit, threshold, vectorWeight }: { query: string; limit?: number; threshold?: number; vectorWeight?: number }) => {
      log.info('Hybrid search executed', { query, limit, threshold, vectorWeight, repositoryIds });

      try {
        // SECURITY: Verify user has access to repositories
        const accessibleRepoIds = await verifyRepositoryAccess(repositoryIds, userCognitoSub);

        if (accessibleRepoIds.length === 0) {
          log.warn('No accessible repositories for hybrid search', { userCognitoSub, requestedRepos: repositoryIds });
          return {
            success: false,
            error: 'No access to specified repositories',
            query
          };
        }

        const topResults = await searchAccessibleRepositories({
          query,
          repositoryIds: accessibleRepoIds,
          userCognitoSub,
          mode: 'hybrid',
          limit: limit ?? 5,
          threshold: threshold ?? 0.7,
          vectorWeight: vectorWeight ?? 0.7,
        });

        if (topResults.length === 0) {
          return {
            success: true,
            results: [],
            message: `No results found for query: "${query}"`
          };
        }

        // Format results for LLM consumption
        const formattedResults = topResults.map((result, idx) => ({
          rank: idx + 1,
          content: result.content,
          source: result.itemName,
          score: Math.round(result.similarity * 100) / 100,
          chunkIndex: result.chunkIndex,
          citation: result.citation,
          context: result.context,
        }));

        log.info('Hybrid search completed', { resultCount: formattedResults.length });

        return {
          success: true,
          resultCount: formattedResults.length,
          query,
          searchType: 'hybrid',
          vectorWeight: vectorWeight ?? 0.7,
          results: formattedResults
        };
      } catch (error) {
        log.error('Hybrid search failed', { error, query });
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Search failed',
          query
        };
      }
    }
  }) as unknown;
}

/**
 * Create all repository search tools for a given configuration
 */
export function createRepositoryTools(options: RepositoryToolOptions) {
  if (!options.repositoryIds || options.repositoryIds.length === 0) {
    return {};
  }

  return {
    vectorSearch: createVectorSearchTool(options),
    keywordSearch: createKeywordSearchTool(options),
    hybridSearch: createHybridSearchTool(options)
  };
}
