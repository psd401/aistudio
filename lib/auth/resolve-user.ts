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
  createUser,
  getRoleByName,
  assignRoleToUser,
} from "@/lib/db/drizzle"
import { createLogger } from "@/lib/logger"
import type { CognitoSession } from "./server-session"

/**
 * Resolve a Cognito session to a numeric database user ID.
 *
 * Flow:
 * 1. Look up user by cognito_sub
 * 2. If not found, look up by email and link cognito_sub
 * 3. If still not found, create user via UPSERT and assign default role
 *
 * @returns Numeric user ID (never null — provisions if missing)
 * @throws If database operations fail
 */
export async function resolveUserId(session: CognitoSession): Promise<number> {
  const log = createLogger({ module: "resolveUserId" })

  // Fast path: user exists
  const existingId = await getUserIdByCognitoSub(session.sub)
  if (existingId) {
    return Number(existingId)
  }

  // Slow path: provision the user
  log.info("User not found by Cognito sub — provisioning", {
    cognitoSub: session.sub,
    hasEmail: !!session.email,
  })

  // Check by email (migration from old auth)
  if (session.email) {
    try {
      const byEmail = await getUserByEmail(session.email)
      if (byEmail) {
        log.info("User found by email, linking Cognito sub", {
          userId: byEmail.id,
        })
        // updateUser is not needed here — createUser UPSERT will handle it
        // Just fall through to the UPSERT below
      }
    } catch {
      // Not found by email — continue to create
    }
  }

  // Create via UPSERT (safe for concurrent requests)
  const username = session.email?.split("@")[0] || ""
  const firstName = session.givenName || username || "User"
  const lastName = session.familyName || undefined

  const newUser = await createUser({
    cognitoSub: session.sub,
    email: session.email || `${session.sub}@cognito.local`,
    firstName,
    lastName,
  })

  const userId = newUser.id as number

  // Assign default role (student for numeric usernames, staff otherwise)
  const isNumeric = /^\d+$/.test(username)
  const defaultRole = isNumeric ? "student" : "staff"
  const role = await getRoleByName(defaultRole)
  if (role) {
    await assignRoleToUser(userId, role.id)
    log.info("User provisioned with default role", {
      userId,
      role: defaultRole,
    })
  } else {
    log.warn("Default role not found — user created without role", {
      userId,
      attemptedRole: defaultRole,
    })
  }

  return userId
}
