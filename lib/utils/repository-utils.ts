import logger from "@/lib/logger"

/**
 * Safely parse repository IDs from database storage
 * Handles both string (JSON) and array formats
 * @param repositoryIds - The repository IDs from database (can be string or array)
 * @returns Parsed array of repository IDs or empty array if parsing fails
 */
export function parseRepositoryIds(repositoryIds: string | number[] | null | undefined): number[] {
  if (!repositoryIds) {
    return [];
  }

  if (Array.isArray(repositoryIds)) {
    // Ensure all elements are numbers
    return repositoryIds.filter(id => typeof id === 'number' && !Number.isNaN(id));
  }

  if (typeof repositoryIds === 'string') {
    try {
      const parsed = JSON.parse(repositoryIds);
      if (Array.isArray(parsed)) {
        return parsed.filter(id => typeof id === 'number' && !Number.isNaN(id));
      }
      logger.warn('Parsed repository_ids is not an array:', parsed);
      return [];
    } catch (e) {
      logger.error('Failed to parse repository_ids:', {
        repositoryIds,
        error: e instanceof Error ? e.message : String(e)
      });
      return [];
    }
  }

  logger.warn('Invalid repository_ids type:', typeof repositoryIds);
  return [];
}

/**
 * Serialize repository IDs for database storage
 * @param repositoryIds - Array of repository IDs
 * @returns JSON string or null if empty
 */
export function serializeRepositoryIds(repositoryIds: number[] | null | undefined): string | null {
  if (!repositoryIds || repositoryIds.length === 0) {
    return '[]'; // Store empty array as JSON string
  }
  
  // Ensure all elements are valid numbers
  const validIds = repositoryIds.filter(id => typeof id === 'number' && !Number.isNaN(id));
  return JSON.stringify(validIds);
}