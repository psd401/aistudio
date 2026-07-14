"use server"

import {
  getUserByCognitoSub,
  getUserByEmail,
  createUser,
  updateUser,
  getRoleByName,
  addUserRole,
  getUserRolesByCognitoSub,
  reconcileUserManagedRoles
} from "@/lib/db/drizzle"
import { getServerSession } from "@/lib/auth/server-session"
import { defaultRoleForNewUser } from "@/lib/auth/default-role"
import { ActionState } from "@/types"
import { SelectUser } from "@/types/db-types"
import { 
  createLogger, 
  generateRequestId, 
  startTimer,
  sanitizeForLogging 
} from "@/lib/logger"
import { 
  handleError, 
  createSuccess,
  ErrorFactories 
} from "@/lib/error-utils"

interface CurrentUserWithRoles {
  user: SelectUser
  roles: { id: number; name: string; description?: string }[]
}

export async function getCurrentUserAction(): Promise<
  ActionState<CurrentUserWithRoles>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getCurrentUserAction")
  const log = createLogger({ 
    requestId, 
    action: "getCurrentUserAction" 
  })
  
  // Declare session outside try block for error handler access
  let session: Awaited<ReturnType<typeof getServerSession>> = null
  
  try {
    log.info("Action started: Retrieving current user")
    
    // Check session
    session = await getServerSession()
    if (!session) {
      log.warn("No active session found")
      throw ErrorFactories.authNoSession()
    }
    
    const userId = session.sub
    const userEmail = session.email
    const userGivenName = session.givenName
    const userFamilyName = session.familyName
    
    log.info("Session validated", { 
      userId,
      userEmail: sanitizeForLogging(userEmail),
      hasGivenName: !!userGivenName,
      hasFamilyName: !!userFamilyName
    })

    // Database operations with detailed logging
    // First try to find user by cognito_sub
    let user: SelectUser | null = null
    
    log.debug("Looking up user by Cognito sub", { cognitoSub: userId })
    const userResult = await getUserByCognitoSub(userId)
    
    if (userResult) {
      user = userResult as unknown as SelectUser
      log.info("User found by Cognito sub", { 
        userId: user.id,
        email: sanitizeForLogging(user.email)
      })
    }

    // If not found by cognito_sub, check if user exists by email
    if (!user && userEmail) {
      log.debug("User not found by Cognito sub, checking by email", {
        email: sanitizeForLogging(userEmail)
      })

      try {
        const existingUser = await getUserByEmail(userEmail)

        if (existingUser) {
          // User exists with this email but different cognito_sub
          // Update the cognito_sub to link to the new auth system
          log.info("User found by email, updating Cognito sub", {
            userId: existingUser.id,
            oldCognitoSub: existingUser.cognitoSub,
            newCognitoSub: userId
          })

          const updatedUser = await updateUser(existingUser.id, { cognitoSub: userId })
          user = updatedUser as unknown as SelectUser

          log.info("User Cognito sub updated successfully", { userId: user.id })
        }
      } catch {
        // User not found by email - will create new user below
        log.debug("No existing user found by email")
      }
    }

    // If user still doesn't exist, create them (UPSERT handles concurrent requests)
    if (!user) {
      log.info("Creating or updating user via UPSERT", {
        cognitoSub: userId,
        email: sanitizeForLogging(userEmail),
        givenName: userGivenName,
        familyName: userFamilyName
      })

      // Extract username once for reuse
      const username = userEmail?.split("@")[0] || ""

      // Use names from Cognito if available, otherwise fall back to username
      const firstName = userGivenName || username || "User"
      const lastName = userFamilyName || undefined

      // UPSERT: inserts if new, updates if concurrent request already created
      const newUserResult = await createUser({
        cognitoSub: userId,
        email: userEmail || `${userId}@cognito.local`,
        firstName: firstName,
        lastName: lastName
      })
      // Type assertion: createUser returns FormattedRow (camelCase with string dates)
      // Convert to SelectUser (camelCase with Date objects) for consistency
      user = newUserResult as unknown as SelectUser

      log.info("User created or updated via UPSERT", {
        userId: user.id,
        firstName: user.firstName,
        lastName: user.lastName
      })

      // Assign the default role (legacy username heuristic — single source of
      // truth in lib/auth/default-role.ts; group-sync reconciliation below is
      // authoritative). `null` means "assign no default role" once the heuristic
      // is retired (coverage-gated, #1207); today it never returns null.
      const defaultRole = defaultRoleForNewUser(userEmail)

      if (defaultRole) {
        log.info("Assigning default role based on username (UPSERT)", {
          username,
          assignedRole: defaultRole
        })

        // addUserRole runs in a transaction, handles role lookup, and increments
        // role_version for session cache invalidation — consistent with resolveUserId
        try {
          await addUserRole(user!.id, defaultRole)
          log.info(`${defaultRole} role assigned to user`, {
            userId: user.id,
            roleName: defaultRole
          })
        } catch (roleError) {
          // Non-fatal: user is provisioned but may lack a role until next login
          log.warn("Default role assignment failed", {
            userId: user.id,
            attemptedRole: defaultRole,
            error: roleError instanceof Error ? roleError.message : "Unknown error"
          })
        }
      } else {
        log.info("No default role assigned (heuristic retired) — relying on group-sync", {
          userId: user.id
        })
      }
    }

    // Update last_sign_in_at and also update names if they're provided in session
    log.debug("Updating user information and last sign-in timestamp")

    // Only log if we're updating names
    if (userGivenName || userFamilyName) {
      log.info("Updating user names from Cognito session", {
        userId: user.id,
        updatingFirstName: !!userGivenName,
        updatingLastName: !!userFamilyName
      })
    }

    // Build update payload conditionally
    const updatePayload: { firstName?: string; lastName?: string; email?: string; lastSignInAt: Date } = {
      lastSignInAt: new Date()
    }
    if (userGivenName) updatePayload.firstName = userGivenName
    if (userFamilyName) updatePayload.lastName = userFamilyName
    // Refresh users.email from the session when it changed (Workspace rename):
    // group_members and the hourly BULK reconciler join on users.email, so a
    // stale value makes the bulk pass compute zero mapped roles and revoke what
    // the login-time reconciler grants — hourly flapping until the email is
    // fresh again (#1222 review). Session establishment is the earliest point
    // the new address is known; between the rename and this next sign-in the
    // bulk pass may drop managed roles once (documented residual).
    if (userEmail && userEmail.toLowerCase() !== (user.email ?? "").toLowerCase()) {
      log.info("Refreshing user email from session (directory rename)", {
        userId: user.id
      })
      updatePayload.email = userEmail
    }

    // The email refresh can violate uq_users_email_lower (migration 112, #1207) when
    // the session's new address already belongs to a DIFFERENT user row (an aliased
    // Workspace address, or a stale duplicate that predates the index). That must NOT
    // hard-fail the whole "who am I" lookup and lock the user out — retry WITHOUT the
    // email so last-sign-in/name still persist, keep the last-known email, and let an
    // admin resolve the collision (report-duplicate-emails.ts). Consistent with the
    // non-fatal treatment of the other authz-constraint writes in this PR.
    try {
      const updatedUser = await updateUser(user.id, updatePayload)
      user = updatedUser as unknown as SelectUser
    } catch (updateError) {
      if ("email" in updatePayload) {
        log.warn("Email refresh hit a uniqueness conflict — keeping last-known email", {
          userId: user.id,
          error: updateError instanceof Error ? updateError.message : "Unknown error"
        })
        const { email: _droppedEmail, ...withoutEmail } = updatePayload
        const updatedUser = await updateUser(user.id, withoutEmail)
        user = updatedUser as unknown as SelectUser
      } else {
        throw updateError
      }
    }

    // Reconcile managed (group-sync) roles from the user's current Google group
    // memberships BEFORE reading roles back, so the response reflects any
    // sync-driven grant/revoke. Manual role assignments are never touched. This
    // is the canonical login-time hook (Epic #1202, Phase 1 / #1204). Non-fatal:
    // a reconciliation failure must not break "who am I" — the user keeps their
    // last-known roles and the hourly sync will reconcile on its next run.
    try {
      // MUST use the live session email, not user.email: users.email is set once
      // at provisioning and never refreshed, while group_members tracks the
      // directory's CURRENT address. Reconciling with the stale DB value would
      // compute a different membership than the session-based JIT paths and flap
      // roles (revoke/re-grant race) after a Workspace email change (#1204 P1).
      await reconcileUserManagedRoles(user.id, userEmail ?? user.email ?? "")
    } catch (reconcileError) {
      log.warn("Managed-role reconciliation failed (non-fatal)", {
        userId: user.id,
        error: reconcileError instanceof Error ? reconcileError.message : "Unknown error"
      })
    }

    // Get user's roles
    log.debug("Fetching user roles")
    const roleNames = await getUserRolesByCognitoSub(userId)
    
    log.info("User roles retrieved", { 
      userId: user.id,
      roleCount: roleNames.length,
      roles: roleNames
    })
    
    const roles = await Promise.all(
      roleNames.map(async name => {
        const role = await getRoleByName(name)
        if (role) {
          return {
            id: role.id,
            name: role.name,
            description: role.description ?? undefined
          }
        }
        return null
      })
    )

    const validRoles = roles.filter((role): role is NonNullable<typeof role> => role !== null)

    // Log success and performance
    timer({
      status: "success",
      userId: user.id,
      roleCount: validRoles.length
    })
    
    log.info("Action completed successfully", {
      userId: user.id,
      email: sanitizeForLogging(user.email),
      roleCount: validRoles.length
    })

    return createSuccess(
      { user, roles: validRoles },
      "User information retrieved successfully"
    )
    
  } catch (error) {
    // Log failure and performance
    timer({ status: "error" })

    // Check for specific AWS token expiration errors
    const isTokenExpiredError = error instanceof Error && (
      error.name === "ExpiredTokenException" ||
      error.message.includes("security token included in the request is expired") ||
      error.message.includes("Token is expired") ||
      error.message.includes("The security token")
    )

    if (isTokenExpiredError) {
      log.warn("AWS token expired - user may need to refresh session", {
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      })

      // Provide specific error message for expired tokens
      return handleError(error, "Your session has expired. Please refresh the page or sign in again.", {
        context: "getCurrentUserAction",
        requestId,
        operation: "getCurrentUserAction",
        metadata: {
          sessionExists: !!session,
          cognitoSub: session?.sub,
          errorType: "token_expired"
        }
      })
    }

    // Use the enhanced error handler with proper context for other errors
    return handleError(error, "Failed to retrieve user information. Please try again or contact support if the issue persists.", {
      context: "getCurrentUserAction",
      requestId,
      operation: "getCurrentUserAction",
      metadata: {
        sessionExists: !!session,
        cognitoSub: session?.sub
      }
    })
  }
} 