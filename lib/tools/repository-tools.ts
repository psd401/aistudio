import { tool } from 'ai';
import { z } from 'zod';
import { vectorSearch, keywordSearch, hybridSearch } from '@/lib/repositories/search-service';
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

/**
 * Verify user has access to specified repositories
 * @throws Error if user has no access to any repositories
 */
async function verifyRepositoryAccess(
  repositoryIds: number[],
  userCognitoSub: string,
  assistantOwnerSub?: string
): Promise<number[]> {
  const repositories = await getAccessibleRepositoriesByCognitoSub(
    repositoryIds,
    userCognitoSub,
    assistantOwnerSub
  );

  return repositories
    .filter(repo => repo.isAccessible)
    .map(repo => repo.id);
}

/**
 * Create vector search tool for semantic similarity search
 */
export function createVectorSearchTool(options: RepositoryToolOptions): unknown {
  const { repositoryIds, userCognitoSub, assistantOwnerSub } = options;
  const log = createLogger({ module: 'repository-tools', tool: 'vectorSearch' });

  return tool({
    description: `Search repository knowledge base using semantic vector similarity. Best for finding conceptually related content even if exact keywords don't match. Searches repositories: ${repositoryIds.join(', ')}`,
    parameters: z.object({
      query: z.string().describe('The search query to find relevant content'),
      limit: z.number().min(1).max(100).optional().default(5).describe('Maximum number of results to return (1-100, default: 5)'),
      threshold: z.number().min(0).max(1).optional().default(0.7).describe('Similarity threshold 0-1 (default: 0.7)')
    }),
    // @ts-expect-error - AI SDK v5 tool() function has complex type inference that doesn't match TypeScript's requirements
    execute: async ({ query, limit, threshold }: { query: string; limit?: number; threshold?: number }) => {
      log.info('Vector search executed', { query, limit, threshold, repositoryIds });

      try {
        // SECURITY: Verify user has access to repositories
        const accessibleRepoIds = await verifyRepositoryAccess(repositoryIds, userCognitoSub, assistantOwnerSub);

        if (accessibleRepoIds.length === 0) {
          log.warn('No accessible repositories for vector search', { userCognitoSub, requestedRepos: repositoryIds });
          return {
            success: false,
            error: 'No access to specified repositories',
            query
          };
        }

        const allResults = [];

        // Search each accessible repository
        for (const repoId of accessibleRepoIds) {
          const results = await vectorSearch(query, {
            repositoryId: repoId,
            limit: limit || 5,
            threshold: threshold || 0.7
          });

          allResults.push(...results);
        }

        // Sort by similarity and take top results
        allResults.sort((a, b) => b.similarity - a.similarity);
        const topResults = allResults.slice(0, limit || 5);

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
          chunkIndex: result.chunkIndex
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
  const { repositoryIds, userCognitoSub, assistantOwnerSub } = options;
  const log = createLogger({ module: 'repository-tools', tool: 'keywordSearch' });

  return tool({
    description: `Search repository knowledge base using exact keyword matching. Best for finding specific terms, phrases, or technical names. Searches repositories: ${repositoryIds.join(', ')}`,
    parameters: z.object({
      query: z.string().describe('The keyword or phrase to search for'),
      limit: z.number().min(1).max(100).optional().default(5).describe('Maximum number of results to return (1-100, default: 5)')
    }),
    // @ts-expect-error - AI SDK v5 tool() function has complex type inference that doesn't match TypeScript's requirements
    execute: async ({ query, limit }: { query: string; limit?: number }) => {
      log.info('Keyword search executed', { query, limit, repositoryIds });

      try {
        // SECURITY: Verify user has access to repositories
        const accessibleRepoIds = await verifyRepositoryAccess(repositoryIds, userCognitoSub, assistantOwnerSub);

        if (accessibleRepoIds.length === 0) {
          log.warn('No accessible repositories for keyword search', { userCognitoSub, requestedRepos: repositoryIds });
          return {
            success: false,
            error: 'No access to specified repositories',
            query
          };
        }

        const allResults = [];

        // Search each accessible repository
        for (const repoId of accessibleRepoIds) {
          const results = await keywordSearch(query, {
            repositoryId: repoId,
            limit: limit || 5
          });

          allResults.push(...results);
        }

        // Sort by rank and take top results
        allResults.sort((a, b) => b.similarity - a.similarity);
        const topResults = allResults.slice(0, limit || 5);

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
          chunkIndex: result.chunkIndex
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
  const { repositoryIds, userCognitoSub, assistantOwnerSub } = options;
  const log = createLogger({ module: 'repository-tools', tool: 'hybridSearch' });

  return tool({
    description: `Search repository knowledge base using combined semantic and keyword matching. Best for comprehensive search that balances conceptual similarity with exact matches. Searches repositories: ${repositoryIds.join(', ')}`,
    parameters: z.object({
      query: z.string().describe('The search query'),
      limit: z.number().min(1).max(100).optional().default(5).describe('Maximum number of results to return (1-100, default: 5)'),
      threshold: z.number().min(0).max(1).optional().default(0.7).describe('Similarity threshold 0-1 (default: 0.7)'),
      vectorWeight: z.number().min(0).max(1).optional().default(0.7).describe('Weight for vector search 0-1 (default: 0.7, keyword gets remainder)')
    }),
    // @ts-expect-error - AI SDK v5 tool() function has complex type inference that doesn't match TypeScript's requirements
    execute: async ({ query, limit, threshold, vectorWeight }: { query: string; limit?: number; threshold?: number; vectorWeight?: number }) => {
      log.info('Hybrid search executed', { query, limit, threshold, vectorWeight, repositoryIds });

      try {
        // SECURITY: Verify user has access to repositories
        const accessibleRepoIds = await verifyRepositoryAccess(repositoryIds, userCognitoSub, assistantOwnerSub);

        if (accessibleRepoIds.length === 0) {
          log.warn('No accessible repositories for hybrid search', { userCognitoSub, requestedRepos: repositoryIds });
          return {
            success: false,
            error: 'No access to specified repositories',
            query
          };
        }

        const allResults = [];

        // Search each accessible repository
        for (const repoId of accessibleRepoIds) {
          const results = await hybridSearch(query, {
            repositoryId: repoId,
            limit: limit || 5,
            threshold: threshold || 0.7,
            vectorWeight: vectorWeight || 0.7
          });

          allResults.push(...results);
        }

        // Sort by combined score and take top results
        allResults.sort((a, b) => b.similarity - a.similarity);
        const topResults = allResults.slice(0, limit || 5);

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
          chunkIndex: result.chunkIndex
        }));

        log.info('Hybrid search completed', { resultCount: formattedResults.length });

        return {
          success: true,
          resultCount: formattedResults.length,
          query,
          searchType: 'hybrid',
          vectorWeight: vectorWeight || 0.7,
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
