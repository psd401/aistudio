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
import { nexusUserPreferences, users } from "@/lib/db/schema"
import type { UserProfile } from "@/lib/db/types/jsonb"
import { mergeNexusUserSettings } from "@/lib/nexus/user-settings"
import { z } from "zod"
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

export interface NexusChatPreferences {
  mode: "standard" | "advanced"
  family: "auto" | "openai" | "anthropic" | "google"
}

const NexusChatPreferencesSchema = z.object({
  mode: z.enum(["standard", "advanced"]),
  family: z.enum(["auto", "openai", "anthropic", "google"]),
}).refine(
  value => value.mode === "standard" || value.family !== "auto",
  { path: ["family"], message: "Advanced mode requires ChatGPT, Claude, or Gemini" }
)

const DEFAULT_NEXUS_CHAT_PREFERENCES: NexusChatPreferences = {
  mode: "standard",
  family: "auto",
}

export async function getNexusChatPreferences(): Promise<ActionState<NexusChatPreferences>> {
  const requestId = generateRequestId()
  const timer = startTimer("getNexusChatPreferences")
  try {
    const session = await getServerSession()
    if (!session) throw ErrorFactories.authNoSession()
    const userId = await getUserIdByCognitoSubAsNumber(session.sub)
    if (!userId) throw ErrorFactories.dbRecordNotFound("users", session.sub)

    const [preference] = await executeQuery(
      db => db.select({ settings: nexusUserPreferences.settings })
        .from(nexusUserPreferences)
        .where(eq(nexusUserPreferences.userId, userId))
        .limit(1),
      "getNexusChatPreferences"
    )
    const parsed = NexusChatPreferencesSchema.safeParse({
      mode: preference?.settings?.nexusMode ?? DEFAULT_NEXUS_CHAT_PREFERENCES.mode,
      family: preference?.settings?.preferredModelFamily ?? DEFAULT_NEXUS_CHAT_PREFERENCES.family,
    })
    timer({ status: "success" })
    return createSuccess(parsed.success ? parsed.data : DEFAULT_NEXUS_CHAT_PREFERENCES)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load Nexus preferences", {
      context: "getNexusChatPreferences", requestId, operation: "getNexusChatPreferences",
    })
  }
}

export async function updateNexusChatPreferences(
  input: NexusChatPreferences
): Promise<ActionState<NexusChatPreferences>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateNexusChatPreferences")
  const log = createLogger({ requestId, action: "updateNexusChatPreferences" })
  try {
    const parsed = NexusChatPreferencesSchema.safeParse(input)
    if (!parsed.success) {
      throw ErrorFactories.validationFailed(parsed.error.issues.map(issue => ({
        field: issue.path.join("."), message: issue.message,
      })))
    }
    const session = await getServerSession()
    if (!session) throw ErrorFactories.authNoSession()
    const userId = await getUserIdByCognitoSubAsNumber(session.sub)
    if (!userId) throw ErrorFactories.dbRecordNotFound("users", session.sub)

    await mergeNexusUserSettings(userId, {
      nexusMode: parsed.data.mode,
      preferredModelFamily: parsed.data.family,
    })
    timer({ status: "success" })
    log.info("Nexus chat preferences updated", { userId, ...parsed.data })
    return createSuccess(parsed.data)
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update Nexus preferences", {
      context: "updateNexusChatPreferences", requestId, operation: "updateNexusChatPreferences",
    })
  }
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

    const validationErrors = profileValidationErrors(input)
    if (validationErrors.length > 0) {
      throw ErrorFactories.validationFailed(validationErrors)
    }
    const setClause = await buildProfileUpdate(userId, input)

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

type ProfileValidationIssue = { field: string; message: string }

function profileValidationErrors(
  input: UpdateProfileInput
): ProfileValidationIssue[] {
  const errors: ProfileValidationIssue[] = []
  addLengthError(errors, "jobTitle", input.jobTitle, 255, "Job title")
  addLengthError(errors, "department", input.department, 255, "Department")
  addLengthError(errors, "building", input.building, 255, "Building")
  addLengthError(errors, "bio", input.bio, 500, "Bio")
  addProfileJsonErrors(errors, input.profile)
  return errors
}

function addLengthError(
  errors: ProfileValidationIssue[],
  field: string,
  value: string | null | undefined,
  maximum: number,
  label: string
): void {
  if (value && value.length > maximum) {
    errors.push({
      field,
      message: `${label} must be ${maximum} characters or less`,
    })
  }
}

function addProfileJsonErrors(
  errors: ProfileValidationIssue[],
  profile: UpdateProfileInput["profile"]
): void {
  if (!profile) return
  const years = profile.yearsInDistrict
  if (
    years !== undefined &&
    (typeof years !== "number" ||
      !Number.isFinite(years) ||
      years < 0 ||
      years > 100)
  ) {
    errors.push({
      field: "yearsInDistrict",
      message: "Years in district must be between 0 and 100",
    })
  }
  addLengthError(errors, "preferredName", profile.preferredName, 255, "Preferred name")
  addLengthError(errors, "pronouns", profile.pronouns, 100, "Pronouns")
}

async function buildProfileUpdate(
  userId: number,
  input: UpdateProfileInput
): Promise<Record<string, unknown>> {
  const update: Record<string, unknown> = { updatedAt: new Date() }
  copyDefinedProfileColumns(update, input)
  if (input.profile && Object.keys(input.profile).length > 0) {
    update.profile = await mergedProfileSql(userId, input.profile)
  }
  return update
}

function copyDefinedProfileColumns(
  update: Record<string, unknown>,
  input: UpdateProfileInput
): void {
  if (input.jobTitle !== undefined) update.jobTitle = input.jobTitle
  if (input.department !== undefined) update.department = input.department
  if (input.building !== undefined) update.building = input.building
  if (input.gradeLevels !== undefined) update.gradeLevels = input.gradeLevels
  if (input.bio !== undefined) update.bio = input.bio
}

async function mergedProfileSql(
  userId: number,
  profile: NonNullable<UpdateProfileInput["profile"]>
) {
  const [currentUser] = await executeQuery(
    (db) =>
      db
        .select({ profile: users.profile })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    "getUserProfileForMerge"
  )
  const merged: UserProfile = {
    ...(currentUser?.profile ?? {}),
    ...profile,
  }
  return sql`${safeJsonbStringify(merged)}::jsonb`
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
