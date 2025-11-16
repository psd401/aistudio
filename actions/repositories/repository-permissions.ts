/* eslint-disable logging/require-request-id, logging/require-logger-in-server-actions */
"use server"

import { executeSQL } from "@/lib/db/data-api-adapter"
import { hasRole } from "@/utils/roles"
import { createError } from "@/lib/error-utils"
import { ErrorLevel } from "@/types/actions-types"

/**
 * Check if a user can modify a repository
 * Returns true if the user is the owner or an administrator
 */
export async function canModifyRepository(
  repositoryId: number,
  userId: number
): Promise<boolean> {
  // Check if user owns the repository
  const ownerCheck = await executeSQL<{ id: number }>(
    `SELECT 1 as id FROM knowledge_repositories 
     WHERE id = :repositoryId AND owner_id = :userId`,
    [
      { name: "repositoryId", value: { longValue: repositoryId } },
      { name: "userId", value: { longValue: userId } }
    ]
  )
  
  if (ownerCheck.length > 0) return true
  
  // Check if user is administrator
  return await hasRole("administrator")
}

/**
 * Get user ID from cognito_sub
 * Returns the user's database ID or throws error if not found
 */
export async function getUserIdFromSession(cognitoSub: string): Promise<number> {
  const userResult = await executeSQL<{ id: number }>(
    `SELECT id FROM users WHERE cognito_sub = :cognito_sub`,
    [{ name: "cognito_sub", value: { stringValue: cognitoSub } }]
  )

  if (userResult.length === 0) {
    throw createError("User not found", { level: ErrorLevel.ERROR })
  }

  return userResult[0].id
}