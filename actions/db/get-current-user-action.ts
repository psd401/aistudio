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

type CurrentSession = NonNullable<Awaited<ReturnType<typeof getServerSession>>>
type ActionLog = ReturnType<typeof createLogger>

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
    
    logSession(session, log)
    let user = await resolveCurrentUser(session, log)
    user = await refreshCurrentUser(user, session, log)
    await reconcileManagedRoles(user, session.email, log)
    const validRoles = await loadCurrentUserRoles(session.sub, user.id, log)

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
    return handleCurrentUserError(error, session, requestId, log)
  }
}

function logSession(session: CurrentSession, log: ActionLog): void {
  log.info("Session validated", {
    userId: session.sub,
    userEmail: sanitizeForLogging(session.email),
    hasGivenName: !!session.givenName,
    hasFamilyName: !!session.familyName
  })
}

async function resolveCurrentUser(
  session: CurrentSession,
  log: ActionLog
): Promise<SelectUser> {
  log.debug("Looking up user by Cognito sub", { cognitoSub: session.sub })
  const bySub = await getUserByCognitoSub(session.sub)
  if (bySub) {
    const user = bySub as unknown as SelectUser
    log.info("User found by Cognito sub", {
      userId: user.id,
      email: sanitizeForLogging(user.email)
    })
    return user
  }
  const byEmail = await linkExistingUserByEmail(session, log)
  return byEmail ?? provisionCurrentUser(session, log)
}

async function linkExistingUserByEmail(
  session: CurrentSession,
  log: ActionLog
): Promise<SelectUser | null> {
  if (!session.email) return null
  log.debug("User not found by Cognito sub, checking by email", {
    email: sanitizeForLogging(session.email)
  })
  try {
    const existing = await getUserByEmail(session.email)
    if (!existing) return null
    log.info("User found by email, updating Cognito sub", {
      userId: existing.id,
      oldCognitoSub: existing.cognitoSub,
      newCognitoSub: session.sub
    })
    const user = await updateUser(existing.id, { cognitoSub: session.sub })
    log.info("User Cognito sub updated successfully", { userId: user.id })
    return user as unknown as SelectUser
  } catch {
    log.debug("No existing user found by email")
    return null
  }
}

async function provisionCurrentUser(
  session: CurrentSession,
  log: ActionLog
): Promise<SelectUser> {
  const username = session.email?.split("@")[0] || ""
  const created = await createUser({
    cognitoSub: session.sub,
    email: session.email || `${session.sub}@cognito.local`,
    firstName: session.givenName || username || "User",
    lastName: session.familyName || undefined
  })
  const user = created as unknown as SelectUser
  log.info("User created or updated via UPSERT", {
    userId: user.id,
    firstName: user.firstName,
    lastName: user.lastName
  })
  await assignDefaultRole(user, session.email, username, log)
  return user
}

async function assignDefaultRole(
  user: SelectUser,
  email: string | undefined,
  username: string,
  log: ActionLog
): Promise<void> {
  const defaultRole = defaultRoleForNewUser(email)
  if (!defaultRole) {
    log.info("No default role assigned (heuristic retired) — relying on group-sync", {
      userId: user.id
    })
    return
  }
  log.info("Assigning default role based on username (UPSERT)", {
    username,
    assignedRole: defaultRole
  })
  try {
    await addUserRole(user.id, defaultRole)
    log.info(`${defaultRole} role assigned to user`, {
      userId: user.id,
      roleName: defaultRole
    })
  } catch (error) {
    log.warn("Default role assignment failed", {
      userId: user.id,
      attemptedRole: defaultRole,
      error: error instanceof Error ? error.message : "Unknown error"
    })
  }
}

interface CurrentUserUpdate {
  firstName?: string
  lastName?: string
  email?: string
  lastSignInAt: Date
}

async function refreshCurrentUser(
  user: SelectUser,
  session: CurrentSession,
  log: ActionLog
): Promise<SelectUser> {
  const update = currentUserUpdate(user, session, log)
  try {
    return await updateCurrentUser(user.id, update)
  } catch (error) {
    if (!update.email) throw error
    log.warn("Email refresh hit a uniqueness conflict — keeping last-known email", {
      userId: user.id,
      error: error instanceof Error ? error.message : "Unknown error"
    })
    const { email: _droppedEmail, ...withoutEmail } = update
    return updateCurrentUser(user.id, withoutEmail)
  }
}

function currentUserUpdate(
  user: SelectUser,
  session: CurrentSession,
  log: ActionLog
): CurrentUserUpdate {
  const update: CurrentUserUpdate = { lastSignInAt: new Date() }
  if (session.givenName) update.firstName = session.givenName
  if (session.familyName) update.lastName = session.familyName
  if (
    session.email &&
    session.email.toLowerCase() !== (user.email ?? "").toLowerCase()
  ) {
    log.info("Refreshing user email from session (directory rename)", {
      userId: user.id
    })
    update.email = session.email
  }
  return update
}

async function updateCurrentUser(
  userId: number,
  update: CurrentUserUpdate
): Promise<SelectUser> {
  return await updateUser(userId, update) as unknown as SelectUser
}

async function reconcileManagedRoles(
  user: SelectUser,
  sessionEmail: string | undefined,
  log: ActionLog
): Promise<void> {
  try {
    await reconcileUserManagedRoles(user.id, sessionEmail ?? user.email ?? "")
  } catch (error) {
    log.warn("Managed-role reconciliation failed (non-fatal)", {
      userId: user.id,
      error: error instanceof Error ? error.message : "Unknown error"
    })
  }
}

async function loadCurrentUserRoles(
  cognitoSub: string,
  userId: number,
  log: ActionLog
): Promise<CurrentUserWithRoles["roles"]> {
  log.debug("Fetching user roles")
  const roleNames = await getUserRolesByCognitoSub(cognitoSub)
  log.info("User roles retrieved", {
    userId,
    roleCount: roleNames.length,
    roles: roleNames
  })
  const roles = await Promise.all(roleNames.map(async name => {
    const role = await getRoleByName(name)
    return role
      ? { id: role.id, name: role.name, description: role.description ?? undefined }
      : null
  }))
  return roles.filter((role): role is NonNullable<typeof role> => role !== null)
}

function handleCurrentUserError(
  error: unknown,
  session: Awaited<ReturnType<typeof getServerSession>>,
  requestId: string,
  log: ActionLog
): ActionState<CurrentUserWithRoles> {
  const tokenExpired = isExpiredSecurityToken(error)
  if (tokenExpired) {
    log.warn("AWS token expired - user may need to refresh session", {
      errorName: error instanceof Error ? error.name : "Unknown",
      errorMessage: error instanceof Error ? error.message : "Unknown error"
    })
  }
  return handleError(
    error,
    tokenExpired
      ? "Your session has expired. Please refresh the page or sign in again."
      : "Failed to retrieve user information. Please try again or contact support if the issue persists.",
    {
      context: "getCurrentUserAction",
      requestId,
      operation: "getCurrentUserAction",
      metadata: {
        sessionExists: !!session,
        cognitoSub: session?.sub,
        ...(tokenExpired ? { errorType: "token_expired" } : {})
      }
    }
  )
}

function isExpiredSecurityToken(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.name === "ExpiredTokenException" ||
    error.message.includes("security token included in the request is expired") ||
    error.message.includes("Token is expired") ||
    error.message.includes("The security token")
  )
}
