/**
 * Logging helper utilities for consistent server action and API route patterns
 * These helpers ensure standardized logging across all server-side operations
 */

import { getServerSession } from "@/lib/auth/server-session"
import { 
  createLogger, 
  generateRequestId, 
  startTimer,
  sanitizeForLogging
} from "@/lib/logger"
import { 
  handleError, 
  ErrorFactories,
  createSuccess
} from "@/lib/error-utils"
import type { ActionState } from "@/types"

/**
 * Options for wrapping server actions with logging
 */
export interface ServerActionOptions {
  actionName: string
  requireAuth?: boolean
  requireRoles?: string[]
  sanitizeParams?: (params: unknown) => unknown
  metadata?: Record<string, unknown>
}

/**
 * Wraps a server action with comprehensive logging, error handling, and performance tracking
 * This is the recommended pattern for all server actions
 * 
 * @example
 * export const myAction = withLogging(
 *   async (params: MyParams, context: LoggingContext) => {
 *     const { log, session } = context
 *     
 *     // Your business logic here
 *     const result = await doSomething(params)
 *     
 *     log.info("Operation completed", { resultCount: result.length })
 *     return result
 *   },
 *   {
 *     actionName: "myAction",
 *     requireAuth: true,
 *     requireRoles: ["admin"],
 *     sanitizeParams: (params) => ({ ...params, password: "[REDACTED]" })
 *   }
 * )
 */
export function withLogging<TParams, TResult>(
  fn: (params: TParams, context: LoggingContext) => Promise<TResult>,
  options: ServerActionOptions
): (params: TParams) => Promise<ActionState<TResult>> {
  return async (params: TParams): Promise<ActionState<TResult>> => {
    const requestId = generateRequestId()
    const timer = startTimer(options.actionName)
    
    // Create logger with context
    const log = createLogger({
      requestId,
      action: options.actionName,
      ...options.metadata
    })
    
    try {
      // Log action start
      log.info(`Action started`, {
        params: options.sanitizeParams 
          ? sanitizeForLogging(options.sanitizeParams(params))
          : sanitizeForLogging(params)
      })
      
      // Check authentication if required
      let session = null
      let userId: string | undefined
      
      if (options.requireAuth) {
        session = await getServerSession()
        if (!session) {
          log.warn("Unauthorized access attempt")
          throw ErrorFactories.authNoSession()
        }
        
        userId = session.sub
        
        // Update logger context with user info
        log.info("User authenticated", { 
          userId,
          userEmail: sanitizeForLogging(session.email)
        })
      }
      
      // Check authorization if roles required
      if (options.requireRoles && options.requireRoles.length > 0 && session) {
        log.debug("Checking user roles", { 
          requiredRoles: options.requireRoles,
          userId 
        })
        
        // Import role checking utilities
        const { getUserRolesByCognitoSub } = await import("@/lib/db/drizzle")
        const { hasRole } = await import("@/utils/roles")

        // Get user's actual roles
        const userRoles = await getUserRolesByCognitoSub(session.sub)
        log.debug("User roles retrieved", { userRoles })

        // Check if user has any of the required roles
        const hasRequiredRole = await Promise.all(
          options.requireRoles.map(role => hasRole(role))
        ).then(results => results.some(roleCheck => roleCheck))
        
        if (!hasRequiredRole) {
          log.warn("Authorization failed - insufficient permissions", {
            requiredRoles: options.requireRoles,
            userRoles,
            userId
          })
          throw ErrorFactories.authzInsufficientPermissions(
            options.requireRoles.join(", "), 
            userRoles
          )
        }
        
        log.info("Authorization successful", { 
          requiredRoles: options.requireRoles,
          userRoles 
        })
      }
      
      // Create context for the action
      const context: LoggingContext = {
        log,
        requestId,
        session,
        userId,
        timer
      }
      
      // Execute the action
      const result = await fn(params, context)
      
      // Log success and performance
      const endTimer = timer
      endTimer({ 
        status: "success",
        ...(Array.isArray(result) && { recordCount: result.length })
      })
      
      log.info("Action completed successfully")
      
      return createSuccess(result)
      
    } catch (error) {
      // Log failure and performance
      const endTimer = timer
      endTimer({ status: "error" })
      
      return handleError(error, undefined, {
        context: options.actionName,
        requestId,
        operation: options.actionName,
        metadata: options.metadata
      })
    }
  }
}

/**
 * Context provided to wrapped server actions
 */
export interface LoggingContext {
  log: ReturnType<typeof createLogger>
  requestId: string
  session: Awaited<ReturnType<typeof getServerSession>> | null
  userId?: string
  timer: ReturnType<typeof startTimer>
}

/**
 * Simplified wrapper for actions that don't need the full logging context
 * Useful for simple CRUD operations
 */
export function withSimpleLogging<TResult>(
  actionName: string,
  fn: () => Promise<TResult>,
  options?: {
    requireAuth?: boolean
    metadata?: Record<string, unknown>
  }
): () => Promise<ActionState<TResult>> {
  // Create a wrapper that accepts params but doesn't use them
  const wrapper = withLogging<undefined, TResult>(
    async () => fn(),
    {
      actionName,
      requireAuth: options?.requireAuth,
      metadata: options?.metadata
    }
  )
  
  // Return a function that doesn't require params
  return () => wrapper(undefined)
}

/**
 * Creates a logged database operation wrapper
 * Automatically handles common database errors with proper categorization
 * 
 * @param operation - The name of the database operation
 * @param context - Additional context for error reporting
 * @param query - The database query function to execute
 */
export function withDatabaseLogging<T>(
  operation: string,
  context: {
    query?: string
    table?: string
    parameters?: unknown[]
    field?: string
  },
  query: () => Promise<T>
): Promise<T> {
  const timer = startTimer(`db.${operation}`)
  
  return query()
    .then(result => {
      const endTimer = timer
      endTimer({ status: "success" })
      return result
    })
    .catch(error => {
      const endTimer = timer
      endTimer({ status: "error" })
      
      // Categorize database errors with full context
      if (error instanceof Error) {
        const message = error.message.toLowerCase()
        
        if (message.includes("connection refused") || 
            message.includes("econnrefused") || 
            message.includes("connection") || 
            message.includes("connect")) {
          throw ErrorFactories.dbConnectionFailed({ 
            technicalMessage: error.message,
            cause: error,
            ...context
          })
        }
        
        if (message.includes("timeout") || message.includes("timedout")) {
          throw ErrorFactories.dbQueryFailed(
            context.query || "", 
            error, 
            {
              technicalMessage: "Database query timed out",
              table: context.table,
              parameters: context.parameters
            }
          )
        }
        
        if (message.includes("duplicate") || 
            message.includes("unique") || 
            message.includes("already exists")) {
          throw ErrorFactories.dbDuplicateEntry(
            context.table || "", 
            context.field || "", 
            "", 
            {
              technicalMessage: error.message,
              cause: error,
              query: context.query,
              parameters: context.parameters
            }
          )
        }
        
        if (message.includes("constraint") || 
            message.includes("violates") || 
            message.includes("foreign key")) {
          // Add constraint violation handling
          throw ErrorFactories.dbQueryFailed(
            context.query || "",
            error,
            {
              technicalMessage: "Database constraint violation",
              table: context.table,
              parameters: context.parameters
            }
          )
        }
        
        // Generic query failure with full context
        throw ErrorFactories.dbQueryFailed(
          context.query || "", 
          error,
          {
            table: context.table,
            parameters: context.parameters
          }
        )
      }
      
      throw error
    })
}

/**
 * Logs API route requests with automatic error handling
 */
export async function withApiLogging<T>(
  request: Request,
  routeName: string,
  handler: (log: ReturnType<typeof createLogger>) => Promise<T>
): Promise<Response> {
  const requestId = request.headers.get("x-request-id") || generateRequestId()
  const timer = startTimer(`api.${routeName}`)
  
  const log = createLogger({
    requestId,
    route: routeName,
    method: request.method,
    url: request.url
  })
  
  try {
    log.info("API request received")
    
    const result = await handler(log)
    
    const endTimer = timer
    endTimer({ status: "success" })
    
    return Response.json(createSuccess(result))
    
  } catch (error) {
    const endTimer = timer
    endTimer({ status: "error" })
    
    const errorResponse = handleError(error, undefined, {
      context: `api.${routeName}`,
      requestId,
      operation: routeName
    })
    
    // Get status code from error if it's typed
    let statusCode = 500
    if (error instanceof Error && "statusCode" in error) {
      const typedError = error as unknown as { statusCode?: number }
      statusCode = typedError.statusCode || 500
    }
    
    return Response.json(errorResponse, { status: statusCode })
  }
}