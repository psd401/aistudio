import "server-only";

import { checkUserRole, getRepositoryById } from "@/lib/db/drizzle";
import { ErrorCode } from "@/types/error-types";
import { assertNotSystemManagedRepository } from "./repository-access-guard";

/**
 * Session-free repository authorization.
 *
 * `actions/repositories/repository-permissions.ts` holds the SESSION-bound
 * checks (`canModifyRepository`, `canReadRepository`), which resolve the
 * caller's role through `hasRole()` and therefore only work behind a browser
 * cookie. This module holds the check that does NOT: it takes an already-
 * resolved `userId`, so an API-key, OAuth-bearer or MCP caller can use it.
 *
 * It lives in `lib/` rather than `actions/` because `lib/mcp` consumes it
 * (#1907) and `lib` must not depend on `actions`. The actions module re-exports
 * it so its existing importers keep their path.
 *
 * This is NOT a `"use server"` module: as a server action,
 * `canModifyUserManagedDurableRepository(repoId, userId)` would be a public
 * endpoint and an ownership oracle, because it trusts the caller-supplied
 * `userId`. `import "server-only"` makes a client-component import fail at
 * build time.
 */

/**
 * Check the complete Repository Manager write boundary without turning
 * infrastructure failures into a false "not found" result.
 *
 * The durable-repository guard deliberately uses DB_RECORD_NOT_FOUND to mask
 * absent, inactive, ephemeral, and system-managed repositories. Other failures
 * (for example a database outage) must remain observable to the API layer.
 */
export async function canModifyUserManagedDurableRepository(
  repositoryId: number,
  userId: number
): Promise<boolean> {
  try {
    await assertNotSystemManagedRepository(repositoryId);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === ErrorCode.DB_RECORD_NOT_FOUND
    ) {
      return false;
    }
    throw error;
  }

  const repository = await getRepositoryById(repositoryId);
  if (!repository) return false;
  if (repository.ownerId === userId) return true;

  // API-key and bearer-JWT callers do not necessarily have a browser session.
  // Check the authenticated API principal directly instead of using hasRole(),
  // which resolves the current session cookie.
  return checkUserRole(userId, "administrator");
}
