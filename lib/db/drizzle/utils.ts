/**
 * Shared utility functions for Drizzle ORM operations
 *
 * Common helpers used across multiple Drizzle operation modules.
 */

import { getUserIdByCognitoSub as getUserIdStringByCognitoSub } from "./users";

/**
 * Get numeric user ID by Cognito sub
 *
 * Wraps the users module getUserIdByCognitoSub (which returns string for
 * backward compatibility) and converts to number type for modules that
 * need numeric user IDs (schedules, model comparisons, etc.).
 *
 * @param cognitoSub - Cognito user identifier
 * @returns Numeric user ID or null if not found
 *
 * @example
 * ```typescript
 * const userId = await getUserIdByCognitoSubAsNumber(session.sub);
 * if (!userId) {
 *   throw ErrorFactories.authzResourceNotFound("user", session.sub);
 * }
 * ```
 */
export async function getUserIdByCognitoSubAsNumber(
  cognitoSub: string
): Promise<number | null> {
  const userIdString = await getUserIdStringByCognitoSub(cognitoSub);
  if (!userIdString) {
    return null;
  }

  const userId = Number(userIdString);

  // Handle edge case: if conversion results in NaN
  if (Number.isNaN(userId)) {
    throw new TypeError(
      `Invalid user ID format from database: "${userIdString}" cannot be converted to number`
    );
  }

  return userId;
}
