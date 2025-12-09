"use server"

import {
  getUserByCognitoSub,
  createUser,
  getRoleByName,
  assignRoleToUser,
  getUserRolesByCognitoSub,
  executeSQL
} from "@/lib/db/data-api-adapter"
import { SqlParameter } from "@aws-sdk/client-rds-data"
import { getServerSession } from "@/lib/auth/server-session"
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
      
      const query = `
        SELECT id, cognito_sub, email, first_name, last_name,
               last_sign_in_at, created_at, updated_at
        FROM users
        WHERE email = :email
      `
      const parameters = [
        { name: "email", value: { stringValue: userEmail } }
      ]
      
      const result = await executeSQL<SelectUser>(query, parameters)
      
      if (result.length > 0) {
        // User exists with this email but different cognito_sub
        // Update the cognito_sub to link to the new auth system
        const existingUser = result[0]
        
        log.info("User found by email, updating Cognito sub", {
          userId: existingUser.id,
          oldCognitoSub: existingUser.cognitoSub,
          newCognitoSub: userId
        })
        
        const updateQuery = `
          UPDATE users
          SET cognito_sub = :cognitoSub, updated_at = NOW()
          WHERE id = :userId
          RETURNING id, cognito_sub, email, first_name, last_name, created_at, updated_at
        `
        const updateParams: SqlParameter[] = [
          { name: "cognitoSub", value: { stringValue: userId } },
          { name: "userId", value: { longValue: existingUser.id } }
        ]
        
        const updateResult = await executeSQL<SelectUser>(updateQuery, updateParams)
        user = updateResult[0]
        
        log.info("User Cognito sub updated successfully", { userId: user.id })
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
      user = newUserResult as unknown as SelectUser

      log.info("User created or updated via UPSERT", {
        userId: user.id,
        firstName: user.firstName,
        lastName: user.lastName
      })

      // Check if user already has roles (from concurrent request or existing user)
      const existingRoles = await getUserRolesByCognitoSub(userId)

      if (existingRoles.length === 0) {
        // Only assign default role if user has no roles yet
        const isNumericUsername = /^\d+$/.test(username)
        const defaultRole = isNumericUsername ? "student" : "staff"

        log.info("Determining default role based on username", {
          username,
          isNumeric: isNumericUsername,
          assignedRole: defaultRole
        })

        // Assign determined role to new user
        log.debug(`Assigning ${defaultRole} role to new user`)
        const roleResult = await getRoleByName(defaultRole)

        if (roleResult.length > 0) {
          const role = roleResult[0]
          const roleId = role.id as number
          await assignRoleToUser(user!.id, roleId)
          log.info(`${defaultRole} role assigned to new user`, {
            userId: user.id,
            roleId,
            roleName: defaultRole
          })
        } else {
          log.warn(`${defaultRole} role not found in database - new user has no roles`, {
            attemptedRole: defaultRole
          })
        }
      } else {
        log.info("User already has roles, skipping default role assignment", {
          userId: user.id,
          existingRoleCount: existingRoles.length
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
    
    // Use COALESCE to conditionally update names only if provided
    const updateLastSignInQuery = `
      UPDATE users
      SET first_name = COALESCE(:firstName, first_name),
          last_name = COALESCE(:lastName, last_name),
          last_sign_in_at = NOW(), 
          updated_at = NOW()
      WHERE id = :userId
      RETURNING id, cognito_sub, email, first_name, last_name, last_sign_in_at, created_at, updated_at
    `
    const updateLastSignInParams: SqlParameter[] = [
      { name: "firstName", value: userGivenName ? { stringValue: userGivenName } : { isNull: true } },
      { name: "lastName", value: userFamilyName ? { stringValue: userFamilyName } : { isNull: true } },
      { name: "userId", value: { longValue: user.id } }
    ]
    const updateResult = await executeSQL<SelectUser>(updateLastSignInQuery, updateLastSignInParams)
    user = updateResult[0]

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
        const roleResult = await getRoleByName(name)
        if (roleResult.length > 0) {
          const role = roleResult[0]
          return {
            id: role.id as number,
            name: role.name as string,
            description: role.description as string | undefined
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