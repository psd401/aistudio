/**
 * Resolve a Cognito session to a database user ID.
 *
 * Performs JIT (just-in-time) user provisioning if the user
 * doesn't exist in the database yet. This handles the case where
 * a valid Cognito session has no corresponding users table record
 * (e.g., first login, deleted user re-authenticating).
 *
 * @see actions/db/get-current-user-action.ts for the full provisioning
 *      flow (role assignment, name updates, last sign-in tracking).
 *      This utility performs a lightweight version — lookup + create only.
 */

import {
  getUserIdByCognitoSubAsNumber,
  getUserByEmail,
  updateUser,
  createUser,
  addUserRole,
  reconcileUserManagedRoles,
} from "@/lib/db/drizzle"
import { createLogger, sanitizeForLogging } from "@/lib/logger"
import { ErrorFactories } from "@/lib/error-utils"
import { ErrorCode } from "@/types/error-types"
import { defaultRoleForNewUser } from "./default-role"
import type { CognitoSession } from "./server-session"

function isRecordNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: unknown }).code === ErrorCode.DB_RECORD_NOT_FOUND
  )
}

async function linkExistingUserByEmail(
  session: CognitoSession,
  log: ReturnType<typeof createLogger>
): Promise<number | null> {
  if (!session.email) return null
  try {
    const byEmail = await getUserByEmail(session.email)
    if (!byEmail) return null
    log.info("User found by email, linking Cognito sub", {
      userId: byEmail.id,
    })
    await updateUser(byEmail.id, { cognitoSub: session.sub })
    await reconcileManagedRolesNonFatal(byEmail.id, session.email, log)
    return byEmail.id
  } catch (error) {
    if (!isRecordNotFound(error)) throw error
    return null
  }
}

async function assignDefaultRoleNonFatal(
  userId: number,
  email: string,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const defaultRole = defaultRoleForNewUser(email)
  if (!defaultRole) {
    log.info(
      "No default role assigned (heuristic retired) — relying on group-sync",
      { userId }
    )
    return
  }
  try {
    await addUserRole(userId, defaultRole)
    log.info("User provisioned with default role", {
      userId,
      role: defaultRole,
    })
  } catch (error) {
    const metadata = { userId, attemptedRole: defaultRole }
    if (isRecordNotFound(error)) {
      log.warn(
        "Default role not found in database — user provisioned without role",
        metadata
      )
      return
    }
    log.error(
      "Role assignment failed — infrastructure error; user provisioned without role",
      {
        ...metadata,
        error: error instanceof Error ? error.message : "Unknown error",
      }
    )
  }
}

/**
 * Resolve a Cognito session to a numeric database user ID.
 *
 * Flow:
 * 1. Look up user by cognito_sub (fast path)
 * 2. If not found, look up by email and link cognito_sub (migration path)
 * 3. If still not found, create user via UPSERT and assign default role (new user path)
 *
 * **Write side-effect**: On the first call for a new Cognito user, this function
 * creates a users row and assigns a default role. Callers on read-only (GET) routes
 * accept this one-time write — it is intentional for JIT provisioning.
 *
 * @returns Numeric user ID (never null — provisions if missing)
 * @throws ErrorFactories.missingRequiredField if session has no email (new user only)
 * @throws If database operations fail
 */
export async function resolveUserId(
  session: CognitoSession,
  requestId?: string
): Promise<number> {
  const log = createLogger({ module: "resolveUserId", requestId })

  // Fast path: user exists (returns null on miss, throws TypeError on malformed ID)
  const existingId = await getUserIdByCognitoSubAsNumber(session.sub)
  if (existingId !== null) {
    // Deliberately NO managed-role reconciliation on this path (#1204 review):
    // it serves ~13 polling GET routes, so a reconcile transaction per request
    // is pure load amplification. Steady-state drift is owned by the hourly
    // sync Lambda; session establishment (getCurrentUserAction) reconciles too.
    return existingId
  }

  // Slow path: provision the user
  log.info("User not found by Cognito sub — provisioning", {
    cognitoSub: sanitizeForLogging(session.sub),
    hasEmail: !!session.email,
  })

  const linkedUserId = await linkExistingUserByEmail(session, log)
  if (linkedUserId !== null) return linkedUserId

  // Require a real email for new users — synthetic addresses create permanent
  // bad data in the users table and break downstream notification delivery.
  if (!session.email) {
    log.warn("Cannot provision user: session has no email address", {
      cognitoSub: sanitizeForLogging(session.sub),
    })
    throw ErrorFactories.missingRequiredField("email")
  }

  // New user: create via UPSERT (safe for concurrent requests)
  // session.email is guaranteed non-null after the guard above
  const username = session.email.split("@")[0]
  const firstName = session.givenName || username || "User"
  const lastName = session.familyName || undefined

  const newUser = await createUser({
    cognitoSub: session.sub,
    email: session.email,
    firstName,
    lastName,
  })

  // Guard against UPSERT returning no rows (DB trigger, RLS, permission error)
  const userId = newUser?.id
  if (!userId || typeof userId !== "number" || userId <= 0) {
    throw ErrorFactories.dbQueryFailed(
      "createUser UPSERT",
      new Error(`Returned no valid ID for cognitoSub: ${sanitizeForLogging(session.sub)}`)
    )
  }

  await assignDefaultRoleNonFatal(userId, session.email, log)

  // New user just provisioned with the default (manual) role — reconcile any
  // group-sync roles on top from their current memberships (#1204). Non-fatal.
  await reconcileManagedRolesNonFatal(userId, session.email, log)

  return userId
}

/**
 * Reconcile a user's managed (group-sync) roles without ever failing the caller.
 * Auth resolution must never break because group-role reconciliation hit a DB
 * hiccup — the user keeps their last-known roles and the hourly sync (or the next
 * request) will reconcile. A no-op when the session carries no email.
 */
async function reconcileManagedRolesNonFatal(
  userId: number,
  email: string | undefined,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  if (!email) return
  try {
    await reconcileUserManagedRoles(userId, email)
  } catch (error) {
    log.warn("Managed-role reconciliation failed (non-fatal)", {
      userId,
      error: error instanceof Error ? error.message : "Unknown error",
    })
  }
}
