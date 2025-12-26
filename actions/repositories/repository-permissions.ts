/* eslint-disable logging/require-request-id, logging/require-logger-in-server-actions */
"use server"

import {
  getRepositoryById,
  getUserIdByCognitoSubAsNumber
} from "@/lib/db/drizzle"
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
  // Check if user owns the repository via Drizzle
  const repository = await getRepositoryById(repositoryId)

  if (repository && repository.ownerId === userId) return true

  // Check if user is administrator
  return await hasRole("administrator")
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