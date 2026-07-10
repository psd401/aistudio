/* eslint-disable logging/require-request-id, logging/require-logger-in-server-actions */
// The two rules above are path-based (they fire on any actions/ file); this is a
// non-action helper module, so they do not apply — keep the disable.
// REV-COR-063: NOT a "use server" module. These are internal auth helpers
// imported only by other server modules (repository.actions.ts,
// repository-items.actions.ts). As server actions their exports would be public
// endpoints — e.g. canModifyRepository(repoId, userId) becomes an ownership
// oracle because it trusts the caller-supplied userId. `import "server-only"`
// makes a client-component import fail at build time.
import "server-only"

import {
  getRepositoryById,
  getUserIdByCognitoSubAsNumber
} from "@/lib/db/drizzle"
import { hasRole } from "@/utils/roles"
import { createError } from "@/lib/error-utils"
import { ErrorLevel } from "@/types/actions-types"
import { executeQuery } from "@/lib/db/drizzle-client"
import { knowledgeRepositories, repositoryAccess, userRoles } from "@/lib/db/schema"
import { and, eq, isNotNull, or } from "drizzle-orm"

/**
 * Check if a user can modify a repository
 * Returns true if the user is the owner or an administrator
 */
export async function canModifyRepository(
  repositoryId: number,
  userId: number
): Promise<boolean> {
  // Check if user owns the repository via Drizzle
  const repository = await getRepositoryById(repositoryId)

  if (repository && repository.ownerId === userId) return true

  // Check if user is administrator
  return await hasRole("administrator")
}

/**
 * Check if a user can READ a repository. True if the repository is public, the
 * user owns it, the user has a direct repository_access grant, the user has a
 * role-based grant, or the user is an administrator. Mirrors the OR-conditions in
 * getUserAccessibleRepositories (lib/db/drizzle/knowledge-repositories.ts) so the
 * read side matches the list side. Used by the repository read actions and search
 * to close the IDOR where a capability-holder could read any repository by id
 * (REV-COR-061 / REV-SEC-081 / REV-SEC-082).
 */
export async function canReadRepository(
  repositoryId: number,
  userId: number
): Promise<boolean> {
  // Administrators can read any repository.
  if (await hasRole("administrator")) return true

  const rows = await executeQuery(
    (db) =>
      db
        .selectDistinct({ id: knowledgeRepositories.id })
        .from(knowledgeRepositories)
        .leftJoin(
          repositoryAccess,
          eq(repositoryAccess.repositoryId, knowledgeRepositories.id)
        )
        .leftJoin(userRoles, eq(userRoles.roleId, repositoryAccess.roleId))
        .where(
          and(
            eq(knowledgeRepositories.id, repositoryId),
            or(
              eq(knowledgeRepositories.isPublic, true),
              eq(knowledgeRepositories.ownerId, userId),
              and(
                isNotNull(repositoryAccess.userId),
                eq(repositoryAccess.userId, userId)
              ),
              and(isNotNull(userRoles.userId), eq(userRoles.userId, userId))
            )
          )
        )
        .limit(1),
    "canReadRepository"
  )
  return rows.length > 0
}

/**
 * Get user ID from cognito_sub
 * Returns the user's database ID or throws error if not found
 */
export async function getUserIdFromSession(cognitoSub: string): Promise<number> {
  const userId = await getUserIdByCognitoSubAsNumber(cognitoSub)

  if (!userId) {
    throw createError("User not found", { level: ErrorLevel.ERROR })
  }

  return userId
}