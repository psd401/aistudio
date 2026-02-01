"use server"

/**
 * User Settings Server Actions
 * Profile management and API key operations for the /settings page.
 * Part of Epic #674 (External API Platform) - Issue #678
 *
 * API key operations are thin wrappers around key-service.ts (#676).
 * Profile operations use Drizzle ORM directly against the users table.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger"
import {
  handleError,
  ErrorFactories,
  createSuccess,
} from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { getServerSession } from "@/lib/auth/server-session"
import {
  getUserIdByCognitoSubAsNumber,
  getUserRolesByCognitoSub,
} from "@/lib/db/drizzle"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, sql } from "drizzle-orm"
import { users } from "@/lib/db/schema"
import type { UserProfile } from "@/lib/db/types/jsonb"
import {
  generateApiKey,
  revokeApiKey,
  listUserKeys,
  type ApiKeyCreateResult,
  type ApiKeyInfo,
} from "@/lib/api-keys/key-service"
import { getScopesForRoles } from "@/lib/api-keys/scopes"
import { safeJsonbStringify } from "@/lib/db/json-utils"

// ============================================
// Types
// ============================================

export interface UserProfileData {
  id: number
  email: string | null
  firstName: string | null
  lastName: string | null
  jobTitle: string | null
  department: string | null
  building: string | null
  gradeLevels: string[] | null
  bio: string | null
  profile: UserProfile | null
  roles: string[]
}

export interface UpdateProfileInput {
  jobTitle?: string | null
  department?: string | null
  building?: string | null
  gradeLevels?: string[]
  bio?: string | null
  profile?: Partial<UserProfile>
}

export interface CreateApiKeyInput {
  name: string
  scopes: string[]
  expiresAt?: Date
}

// ============================================
// Profile Actions
// ============================================

/**
 * Fetch the current user's profile data, including JSONB profile and roles.
 */
export async function getUserProfile(): Promise<ActionState<UserProfileData>> {
  const requestId = generateRequestId()
  const timer = startTimer("getUserProfile")
  const log = createLogger({ requestId, action: "getUserProfile" })

  try {
    log.info("Fetching user profile")

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdByCognitoSubAsNumber(session.sub)
    if (!userId) {
      throw ErrorFactories.dbRecordNotFound("users", session.sub)
    }

    const [user] = await executeQuery(
      (db) =>
        db
          .select({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            jobTitle: users.jobTitle,
            department: users.department,
            building: users.building,
            gradeLevels: users.gradeLevels,
            bio: users.bio,
            profile: users.profile,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1),
      "getUserProfile"
    )

    if (!user) {
      throw ErrorFactories.dbRecordNotFound("users", String(userId))
    }

    const roles = await getUserRolesByCognitoSub(session.sub)

    timer({ status: "success" })
    log.info("User profile retrieved", { userId })

    return createSuccess({
      ...user,
      roles,
    })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load profile", {
      context: "getUserProfile",
      requestId,
      operation: "getUserProfile",
    })
  }
}

/**
 * Update the current user's profile fields and JSONB profile data.
 * 
 * SECURITY FIX (Issue #678 review): Uses application-layer merge instead of SQL-layer
 * to prevent potential SQL injection vulnerabilities in JSONB operations.
 * 
 * Previous implementation used SQL: `COALESCE(profile, '{}') || ${JSON.stringify(input)}::jsonb`
 * which had potential SQL injection risk despite parameterization.
 * 
 * New approach:
 * 1. Fetch current profile value
 * 2. Merge at application layer (TypeScript)
 * 3. Update with complete merged object using safeJsonbStringify()
 */
export async function updateUserProfile(
  input: UpdateProfileInput
): Promise<ActionState<{ success: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateUserProfile")
  const log = createLogger({ requestId, action: "updateUserProfile" })

  try {
    log.info("Updating user profile", {
      fields: sanitizeForLogging(Object.keys(input)),
    })

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdByCognitoSubAsNumber(session.sub)
    if (!userId) {
      throw ErrorFactories.dbRecordNotFound("users", session.sub)
    }

    // Validate field lengths (defense-in-depth: mirrors client-side validation)
    const validationErrors: Array<{ field: string; message: string }> = []

    if (input.jobTitle && input.jobTitle.length > 255) {
      validationErrors.push({ field: "jobTitle", message: "Job title must be 255 characters or less" })
    }
    if (input.department && input.department.length > 255) {
      validationErrors.push({ field: "department", message: "Department must be 255 characters or less" })
    }
    if (input.building && input.building.length > 255) {
      validationErrors.push({ field: "building", message: "Building must be 255 characters or less" })
    }
    if (input.bio && input.bio.length > 500) {
      validationErrors.push({ field: "bio", message: "Bio must be 500 characters or less" })
    }

    // Validate JSONB profile fields
    if (input.profile) {
      if (input.profile.yearsInDistrict !== undefined) {
        const years = input.profile.yearsInDistrict
        if (typeof years !== "number" || !Number.isFinite(years) || years < 0 || years > 100) {
          validationErrors.push({ field: "yearsInDistrict", message: "Years in district must be between 0 and 100" })
        }
      }
      if (input.profile.preferredName && input.profile.preferredName.length > 255) {
        validationErrors.push({ field: "preferredName", message: "Preferred name must be 255 characters or less" })
      }
      if (input.profile.pronouns && input.profile.pronouns.length > 100) {
        validationErrors.push({ field: "pronouns", message: "Pronouns must be 100 characters or less" })
      }
    }

    if (validationErrors.length > 0) {
      throw ErrorFactories.validationFailed(validationErrors)
    }

    // Build the set clause for standard columns
    const setClause: Record<string, unknown> = {
      updatedAt: new Date(),
    }

    if (input.jobTitle !== undefined) setClause.jobTitle = input.jobTitle
    if (input.department !== undefined) setClause.department = input.department
    if (input.building !== undefined) setClause.building = input.building
    if (input.gradeLevels !== undefined) setClause.gradeLevels = input.gradeLevels
    if (input.bio !== undefined) setClause.bio = input.bio

    // JSONB partial merge: Application-layer merge for security
    // Fetch current profile, merge with updates, then save complete object
    if (input.profile && Object.keys(input.profile).length > 0) {
      // Fetch current profile value
      const [currentUser] = await executeQuery(
        (db) =>
          db
            .select({ profile: users.profile })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1),
        "getUserProfileForMerge"
      )

      // Merge at application layer: existing fields + new fields
      // New fields overwrite, existing fields are preserved
      const currentProfile = currentUser?.profile ?? {}
      const mergedProfile: UserProfile = {
        ...currentProfile,
        ...input.profile,
      }

      // Use safeJsonbStringify for proper JSONB handling with parameterization
      setClause.profile = sql`${safeJsonbStringify(mergedProfile)}::jsonb`
    }

    await executeQuery(
      (db) =>
        db
          .update(users)
          .set(setClause)
          .where(eq(users.id, userId)),
      "updateUserProfile"
    )

    timer({ status: "success" })
    log.info("User profile updated", { userId })

    return createSuccess({ success: true }, "Profile updated successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update profile", {
      context: "updateUserProfile",
      requestId,
      operation: "updateUserProfile",
    })
  }
}

// ============================================
// API Key Actions
// ============================================

/**
 * List the current user's API keys (metadata only, no hashes).
 */
export async function listUserApiKeys(): Promise<ActionState<ApiKeyInfo[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("listUserApiKeys")
  const log = createLogger({ requestId, action: "listUserApiKeys" })

  try {
    log.info("Listing user API keys")

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdByCognitoSubAsNumber(session.sub)
    if (!userId) {
      throw ErrorFactories.dbRecordNotFound("users", session.sub)
    }

    const keys = await listUserKeys(userId)

    timer({ status: "success" })
    log.info("API keys listed", { userId, count: keys.length })

    return createSuccess(keys)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to list API keys", {
      context: "listUserApiKeys",
      requestId,
      operation: "listUserApiKeys",
    })
  }
}

/**
 * Create a new API key for the current user.
 * Validates requested scopes against the user's roles before creation.
 * Returns the raw key ONCE — it cannot be retrieved after this.
 */
export async function createUserApiKey(
  input: CreateApiKeyInput
): Promise<ActionState<ApiKeyCreateResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("createUserApiKey")
  const log = createLogger({ requestId, action: "createUserApiKey" })

  try {
    log.info("Creating API key", {
      name: sanitizeForLogging(input.name),
      scopeCount: input.scopes.length,
    })

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdByCognitoSubAsNumber(session.sub)
    if (!userId) {
      throw ErrorFactories.dbRecordNotFound("users", session.sub)
    }

    // Validate scopes against user's roles (prevent scope escalation)
    const userRoles = await getUserRolesByCognitoSub(session.sub)
    const allowedScopes = getScopesForRoles(userRoles)
    const invalidScopes = input.scopes.filter(
      (s) => !allowedScopes.includes(s as typeof allowedScopes[number])
    )

    if (invalidScopes.length > 0) {
      throw ErrorFactories.validationFailed([
        {
          field: "scopes",
          message: `Scopes not permitted for your role: ${invalidScopes.join(", ")}`,
        },
      ])
    }

    const result = await generateApiKey(
      userId,
      input.name,
      input.scopes,
      input.expiresAt
    )

    timer({ status: "success" })
    log.info("API key created", { keyId: result.keyId, userId })

    return createSuccess(result, "API key created successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to create API key", {
      context: "createUserApiKey",
      requestId,
      operation: "createUserApiKey",
    })
  }
}

/**
 * Revoke an API key owned by the current user.
 * key-service.revokeApiKey enforces ownership via userId filter.
 */
export async function revokeUserApiKey(
  keyId: number
): Promise<ActionState<{ success: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("revokeUserApiKey")
  const log = createLogger({ requestId, action: "revokeUserApiKey" })

  try {
    log.info("Revoking API key", { keyId })

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized")
      throw ErrorFactories.authNoSession()
    }

    const userId = await getUserIdByCognitoSubAsNumber(session.sub)
    if (!userId) {
      throw ErrorFactories.dbRecordNotFound("users", session.sub)
    }

    await revokeApiKey(keyId, userId)

    timer({ status: "success" })
    log.info("API key revoked", { keyId, userId })

    return createSuccess({ success: true }, "API key revoked successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to revoke API key", {
      context: "revokeUserApiKey",
      requestId,
      operation: "revokeUserApiKey",
    })
  }
}
