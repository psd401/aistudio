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
  getUserIdByCognitoSub,
  getUserByEmail,
  updateUser,
  createUser,
  addUserRole,
} from "@/lib/db/drizzle"
import { createLogger, sanitizeForLogging } from "@/lib/logger"
import type { CognitoSession } from "./server-session"

/**
 * Resolve a Cognito session to a numeric database user ID.
 *
 * Flow:
 * 1. Look up user by cognito_sub (fast path)
 * 2. If not found, look up by email and link cognito_sub (migration path)
 * 3. If still not found, create user via UPSERT and assign default role (new user path)
 *
 * @returns Numeric user ID (never null — provisions if missing)
 * @throws If database operations fail or session has no email for a new user
 */
export async function resolveUserId(
  session: CognitoSession,
  requestId?: string
): Promise<number> {
  const log = createLogger({ module: "resolveUserId", requestId })

  // Fast path: user exists
  const existingId = await getUserIdByCognitoSub(session.sub)
  if (existingId) {
    return Number(existingId)
  }

  // Slow path: provision the user
  log.info("User not found by Cognito sub — provisioning", {
    cognitoSub: sanitizeForLogging(session.sub),
    hasEmail: !!session.email,
  })

  // Check by email (migration from old auth — link the new cognitoSub to
  // the existing record rather than creating a duplicate row)
  if (session.email) {
    try {
      const byEmail = await getUserByEmail(session.email)
      if (byEmail) {
        log.info("User found by email, linking Cognito sub", {
          userId: byEmail.id,
        })
        // MUST explicitly update cognitoSub — createUser UPSERT conflicts on
        // cognitoSub, not email. Without this call a duplicate row is inserted.
        // Mirrors getCurrentUserAction.ts:100
        await updateUser(byEmail.id, { cognitoSub: session.sub })
        return byEmail.id
      }
    } catch (error) {
      // getUserByEmail throws dbRecordNotFound when not found — only catch that.
      // Re-throw real DB errors (connection failures, timeouts, etc.)
      const isNotFound =
        error instanceof Error && error.message.toLowerCase().includes("not found")
      if (!isNotFound) {
        throw error
      }
      // User not found by email — fall through to create
    }
  }

  // New user: create via UPSERT (safe for concurrent requests)
  const username = session.email?.split("@")[0] ?? ""

  // Require a real email for new users — synthetic addresses create permanent
  // bad data in the users table and break downstream notification delivery.
  if (!session.email) {
    log.warn("Cannot provision user: session has no email address", {
      cognitoSub: sanitizeForLogging(session.sub),
    })
    throw new Error("Cannot provision user: session contains no email address")
  }

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
    throw new Error(
      `createUser UPSERT returned no valid ID for cognitoSub: ${sanitizeForLogging(session.sub)}`
    )
  }

  // Assign default role using addUserRole, which runs in a transaction and
  // increments role_version for session cache invalidation.
  // Numeric username prefix → student (K-12 district convention: student IDs
  // are all-digit numbers, e.g. 123456@psd401.net). Non-numeric → staff.
  // Defaults to least-privilege (student) when username cannot be determined.
  const isNumeric = username.length > 0 && /^\d+$/.test(username)
  const defaultRole = isNumeric ? "student" : "staff"

  try {
    await addUserRole(userId, defaultRole)
    log.info("User provisioned with default role", {
      userId,
      role: defaultRole,
    })
  } catch (error) {
    // Role assignment failure is non-fatal — user can still access the app,
    // and getCurrentUserAction will handle role assignment on next full login.
    log.warn("Default role assignment failed — user provisioned without role", {
      userId,
      attemptedRole: defaultRole,
      error: error instanceof Error ? error.message : "Unknown error",
    })
  }

  return userId
}
