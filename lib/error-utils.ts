import { AppError, ErrorLevel } from "@/types/actions-types"
import type { ActionState } from "@/types"
import {
  ErrorCode,
  TypedError,
  DatabaseError,
  AuthenticationError,
  AuthorizationError,
  ValidationError,
  ExternalServiceError,
  BusinessLogicError,
  getUserMessage,
  ERROR_STATUS_CODES
} from "@/types/error-types"
import {
  createLogger,
  sanitizeForLogging,
  generateRequestId,
  getLogContext
} from "@/lib/logger"

/**
 * Creates a structured AppError with standardized properties
 * @deprecated Use createTypedError instead for better error categorization
 */
export function createError(
  message: string,
  options: {
    code?: string;
    level?: ErrorLevel;
    details?: Record<string, unknown>;
    cause?: Error;
  } = {}
): AppError {
  const { code, level = ErrorLevel.ERROR, details, cause } = options;
  
  const error = new Error(message, { cause }) as AppError;
  error.code = code;
  error.level = level;
  error.details = details;
  
  return error;
}

/**
 * Creates a typed error with full context and categorization
 */
export function createTypedError<T extends TypedError>(
  code: ErrorCode,
  message: string,
  options: Partial<Omit<T, "name" | "message" | "code">> = {}
): T {
  const error = new Error(message) as T
  error.code = code
  error.level = options.level || getErrorLevelForCode(code)
  error.timestamp = new Date().toISOString()
  error.correlationId = getLogContext().requestId || generateRequestId()
  error.statusCode = ERROR_STATUS_CODES[code] || 500
  error.userMessage = options.userMessage || getUserMessage(code)
  error.technicalMessage = message
  
  // Determine if error is retryable based on code
  error.retryable = isRetryableError(code)
  
  // Merge additional options
  Object.assign(error, options)
  
  // Capture stack trace
  if (Error.captureStackTrace) {
    Error.captureStackTrace(error, createTypedError)
  }
  
  return error
}

/**
 * Factory functions for creating specific error types
 */
export const ErrorFactories = {
  // Database Errors
  dbConnectionFailed: (details?: Partial<DatabaseError>) =>
    createTypedError<DatabaseError>(
      ErrorCode.DB_CONNECTION_FAILED,
      details?.technicalMessage || "Failed to connect to database",
      details
    ),
  
  dbQueryFailed: (query: string, error?: Error, details?: Partial<DatabaseError>) =>
    createTypedError<DatabaseError>(
      ErrorCode.DB_QUERY_FAILED,
      `Query failed: ${error?.message || "Unknown error"}`,
      { ...details, details: { ...details?.details, query }, cause: error }
    ),
  
  dbRecordNotFound: (table: string, id: unknown, details?: Partial<DatabaseError>) =>
    createTypedError<DatabaseError>(
      ErrorCode.DB_RECORD_NOT_FOUND,
      `Record not found in ${sanitizeForLogging(table) as string} with id: [user input: ${sanitizeForLogging(id) as string}]`,
      { table: sanitizeForLogging(table) as string, details: { id: sanitizeForLogging(id) }, ...details }
    ),
  
  dbDuplicateEntry: (table: string, field: string, value: unknown, details?: Partial<DatabaseError>) =>
    createTypedError<DatabaseError>(
      ErrorCode.DB_DUPLICATE_ENTRY,
      `Duplicate entry in ${table}.${field}: ${value}`,
      { ...details, details: { ...details?.details, table, field, value } }
    ),
  
  // Authentication Errors
  authNoSession: (details?: Partial<AuthenticationError>) =>
    createTypedError<AuthenticationError>(
      ErrorCode.AUTH_NO_SESSION,
      "No active session found",
      details
    ),
  
  authInvalidToken: (tokenType?: string, details?: Partial<AuthenticationError>) =>
    createTypedError<AuthenticationError>(
      ErrorCode.AUTH_INVALID_TOKEN,
      `Invalid ${tokenType || "authentication"} token`,
      details
    ),
  
  authExpiredSession: (expiredAt?: string, details?: Partial<AuthenticationError>) =>
    createTypedError<AuthenticationError>(
      ErrorCode.AUTH_EXPIRED_SESSION,
      `Session expired${expiredAt ? ` at ${expiredAt}` : ""}`,
      { expiresAt: expiredAt, ...details }
    ),
  
  // Authorization Errors
  authzInsufficientPermissions: (requiredRole?: string, userRoles?: string[], details?: Partial<AuthorizationError>) =>
    createTypedError<AuthorizationError>(
      ErrorCode.AUTHZ_INSUFFICIENT_PERMISSIONS,
      `Insufficient permissions${requiredRole ? `. Required: ${requiredRole}` : ""}`,
      { requiredRole, userRoles, ...details }
    ),
  
  authzResourceNotFound: (resourceType: string, resourceId: string, details?: Partial<AuthorizationError>) =>
    createTypedError<AuthorizationError>(
      ErrorCode.AUTHZ_RESOURCE_NOT_FOUND,
      `${resourceType} not found or access denied: ${resourceId}`,
      { resourceType, resourceId, ...details }
    ),
  
  authzAdminRequired: (operation?: string, details?: Partial<AuthorizationError>) =>
    createTypedError<AuthorizationError>(
      ErrorCode.AUTHZ_ADMIN_REQUIRED,
      `Administrator privileges required${operation ? ` for ${operation}` : ""}`,
      { requiredRole: "administrator", ...details }
    ),
  
  authzToolAccessDenied: (toolName: string, details?: Partial<AuthorizationError>) =>
    createTypedError<AuthorizationError>(
      ErrorCode.AUTHZ_TOOL_ACCESS_DENIED,
      `Access denied to tool: ${toolName}`,
      { requiredPermission: toolName, ...details }
    ),
  
  authzOwnerRequired: (operation: string, details?: Partial<AuthorizationError>) =>
    createTypedError<AuthorizationError>(
      ErrorCode.AUTHZ_OWNER_REQUIRED,
      `Only the owner can ${operation}`,
      { requiredRole: "owner", ...details }
    ),
  
  // Validation Errors
  validationFailed: (fields: ValidationError["fields"], details?: Partial<ValidationError>) =>
    createTypedError<ValidationError>(
      ErrorCode.VALIDATION_FAILED,
      `Validation failed for ${fields?.length || 0} field(s)`,
      { fields, ...details }
    ),
  
  invalidInput: (field: string, value: unknown, constraint?: string, details?: Partial<ValidationError>) =>
    createTypedError<ValidationError>(
      ErrorCode.INVALID_INPUT,
      `Invalid input for ${field}`,
      { 
        fields: [{ field, value, message: `Invalid value`, constraint }],
        ...details 
      }
    ),
  
  missingRequiredField: (field: string, details?: Partial<ValidationError>) =>
    createTypedError<ValidationError>(
      ErrorCode.MISSING_REQUIRED_FIELD,
      `Missing required field: ${field}`,
      { 
        fields: [{ field, message: "Field is required" }],
        ...details 
      }
    ),
  
  // External Service Errors
  externalServiceError: (serviceName: string, error?: Error, details?: Partial<ExternalServiceError>) =>
    createTypedError<ExternalServiceError>(
      ErrorCode.EXTERNAL_SERVICE_ERROR,
      `External service error: ${serviceName} - ${error?.message || "Unknown error"}`,
      { serviceName, cause: error, ...details }
    ),
  
  externalServiceTimeout: (serviceName: string, timeout: number = 30000, details?: Partial<ExternalServiceError>) =>
    createTypedError<ExternalServiceError>(
      ErrorCode.EXTERNAL_SERVICE_TIMEOUT,
      `${serviceName} timeout after ${timeout}ms`,
      { serviceName, responseTime: timeout, ...details }
    ),
  
  externalApiRateLimit: (serviceName: string, retryAfter?: number, details?: Partial<ExternalServiceError>) =>
    createTypedError<ExternalServiceError>(
      ErrorCode.EXTERNAL_API_RATE_LIMIT,
      `Rate limit exceeded for ${serviceName}${retryAfter ? `. Retry after ${retryAfter}s` : ''}`,
      { serviceName, nextRetryAt: retryAfter ? new Date(Date.now() + retryAfter * 1000).toISOString() : undefined, ...details }
    ),
  
  // Additional Validation Errors
  invalidFormat: (field: string, value: unknown, expectedFormat: string, details?: Partial<ValidationError>) =>
    createTypedError<ValidationError>(
      ErrorCode.INVALID_FORMAT,
      `Invalid format for ${field}. Expected: ${expectedFormat}`,
      { 
        fields: [{ field, value, message: `Invalid format. Expected: ${expectedFormat}`, constraint: expectedFormat }],
        ...details 
      }
    ),
  
  valueOutOfRange: (field: string, value: number, min: number, max: number, details?: Partial<ValidationError>) =>
    createTypedError<ValidationError>(
      ErrorCode.VALUE_OUT_OF_RANGE,
      `${field} value ${value} is out of range [${min}, ${max}]`,
      { 
        fields: [{ field, value, message: `Value must be between ${min} and ${max}`, constraint: `${min}-${max}` }],
        ...details 
      }
    ),
  
  invalidFileType: (field: string, actualType: string, allowedTypes: string[], details?: Partial<ValidationError>) =>
    createTypedError<ValidationError>(
      ErrorCode.INVALID_FILE_TYPE,
      `Invalid file type for ${field}. Got: ${actualType}, Allowed: ${allowedTypes.join(', ')}`,
      { 
        fields: [{ field, value: actualType, message: `File type must be one of: ${allowedTypes.join(', ')}`, constraint: allowedTypes.join(',') }],
        ...details 
      }
    ),
  
  fileTooLarge: (field: string, actualSize: number, maxSize: number, details?: Partial<ValidationError>) =>
    createTypedError<ValidationError>(
      ErrorCode.FILE_TOO_LARGE,
      `File ${field} is too large. Size: ${actualSize} bytes, Max: ${maxSize} bytes`,
      { 
        fields: [{ field, value: actualSize, message: `File size must not exceed ${maxSize} bytes`, constraint: `max:${maxSize}` }],
        ...details 
      }
    ),
  
  // System Errors
  sysInternalError: (message: string, details?: Record<string, unknown>) =>
    createTypedError<TypedError>(
      ErrorCode.SYS_INTERNAL_ERROR,
      message,
      details
    ),
  
  sysConfigurationError: (message: string, details?: Record<string, unknown>) =>
    createTypedError<TypedError>(
      ErrorCode.SYS_CONFIGURATION_ERROR,
      message,
      details
    ),
  
  // Business Logic Errors
  bizInvalidState: (operation: string, currentState: string, expectedState: string, details?: Partial<BusinessLogicError>) =>
    createTypedError<BusinessLogicError>(
      ErrorCode.BIZ_INVALID_STATE,
      `Invalid state for ${operation}. Current: ${currentState}, Expected: ${expectedState}`,
      { operation, currentState, expectedState, ...details }
    ),
  
  bizQuotaExceeded: (operation: string, limit: number, current: number, resetAt?: string, details?: Partial<BusinessLogicError>) =>
    createTypedError<BusinessLogicError>(
      ErrorCode.BIZ_QUOTA_EXCEEDED,
      `Quota exceeded for ${operation}. Limit: ${limit}, Current: ${current}`,
      { operation, quota: { limit, current, resetAt }, ...details }
    ),

  // Streaming and Provider Errors
  providerUnavailable: (provider: string, details?: Partial<ExternalServiceError>) =>
    createTypedError<ExternalServiceError>(
      ErrorCode.EXTERNAL_SERVICE_ERROR,
      `Provider ${provider} is currently unavailable`,
      { serviceName: provider, ...details }
    ),
}

/**
 * Determines the error level based on error code
 */
function getErrorLevelForCode(code: ErrorCode): ErrorLevel {
  // Authentication errors are typically warnings
  if (code.startsWith("AUTH_")) {
    return ErrorLevel.WARN
  }
  
  // Authorization errors are warnings
  if (code.startsWith("AUTHZ_")) {
    return ErrorLevel.WARN
  }
  
  // Validation errors are info level
  if (code.startsWith("VALIDATION_") || 
      code === ErrorCode.INVALID_INPUT ||
      code === ErrorCode.MISSING_REQUIRED_FIELD ||
      code === ErrorCode.INVALID_FORMAT ||
      code === ErrorCode.VALUE_OUT_OF_RANGE ||
      code === ErrorCode.INVALID_FILE_TYPE ||
      code === ErrorCode.FILE_TOO_LARGE) {
    return ErrorLevel.INFO
  }
  
  // System errors are fatal
  if (code.startsWith("SYS_")) {
    return ErrorLevel.FATAL
  }
  
  // Default to ERROR level
  return ErrorLevel.ERROR
}

/**
 * Determines if an error is retryable
 */
function isRetryableError(code: ErrorCode): boolean {
  const retryableCodes = [
    ErrorCode.DB_CONNECTION_FAILED,
    ErrorCode.DB_TIMEOUT,
    ErrorCode.DB_POOL_EXHAUSTED,
    ErrorCode.EXTERNAL_SERVICE_TIMEOUT,
    ErrorCode.EXTERNAL_API_RATE_LIMIT,
    ErrorCode.AWS_SERVICE_ERROR,
    ErrorCode.S3_UPLOAD_FAILED,
    ErrorCode.S3_DOWNLOAD_FAILED,
    ErrorCode.LAMBDA_INVOCATION_FAILED,
  ]
  
  return retryableCodes.includes(code)
}

// CRITICAL: Module-level recursion guard to prevent infinite error handling loops
// This is safe for synchronous code because Node.js is single-threaded
// Synchronous code runs to completion without interruption
let isHandlingError = false

interface HandleErrorOptions {
  context?: string
  requestId?: string
  userId?: string
  includeErrorInResponse?: boolean
  operation?: string
  metadata?: Record<string, unknown>
}

interface ResolvedHandleErrorOptions {
  context: string
  requestId: string
  userId?: string
  includeErrorInResponse: boolean
  operation?: string
  metadata?: Record<string, unknown>
}

type ErrorLog = ReturnType<typeof createLogger>

/**
 * Enhanced error handler with comprehensive logging and categorization
 * Protected against recursive error handling to prevent stack overflow
 * Safe for synchronous code - Node.js single-threaded execution ensures atomicity
 */
export function handleError(
  error: unknown,
  userMessage = "An unexpected error occurred",
  logOptions: HandleErrorOptions = {}
): ActionState<never> {
  // CRITICAL: Prevent recursive error handling (stack overflow protection)
  // Module-level flag is safe because error handling is synchronous
  if (isHandlingError) {
    // Last-resort failsafe: Log recursion without triggering our own error handling
    // This bypasses all logging infrastructure to prevent infinite recursion
    // Use process.stderr.write in Node.js (more reliable for CloudWatch), console.error in Edge Runtime
    const message = `[RECURSION GUARD] Recursive error handling detected: ${String(error)}\n`
    if (typeof process !== 'undefined' && process.stderr?.write) {
      process.stderr.write(message)
    } else {
      // eslint-disable-next-line no-console
      console.error(message)
    }
    return {
      isSuccess: false,
      message: "System error occurred"
    }
  }

  // Set flag before processing, clear in finally block to ensure reset
  isHandlingError = true

  try {

    const options = resolveHandleErrorOptions(logOptions)
    const log = createLogger({
      requestId: options.requestId,
      userId: options.userId,
      context: options.context,
      operation: options.operation
    })
    if (error instanceof Error && "code" in error) {
      return handleTypedError(error as TypedError, userMessage, options, log)
    }
    if (error instanceof Error && 'level' in error && (error as AppError).level) {
      return handleAppError(error as AppError, userMessage, options, log)
    }
    if (typeof AggregateError !== "undefined" && error instanceof AggregateError) {
      return handleAggregateError(error, userMessage, options, log)
    }
    if (error instanceof Error) {
      return handleStandardError(error, userMessage, options, log)
    }
    return handleUnknownError(error, userMessage, options, log)
  } finally {
    // CRITICAL: Always reset flag to allow future error handling
    isHandlingError = false
  }
}

function resolveHandleErrorOptions(
  options: HandleErrorOptions
): ResolvedHandleErrorOptions {
  const context = getLogContext()
  return {
    context: options.context ?? "",
    requestId: options.requestId ?? context.requestId ?? generateRequestId(),
    userId: options.userId ?? context.userId,
    includeErrorInResponse:
      options.includeErrorInResponse ?? process.env.NODE_ENV !== "production",
    operation: options.operation,
    metadata: options.metadata,
  }
}

function handleTypedError(
  error: TypedError,
  fallbackMessage: string,
  options: ResolvedHandleErrorOptions,
  log: ErrorLog
): ActionState<never> {
  const details = sanitizeForLogging({
    code: error.code,
    details: error.details,
    statusCode: error.statusCode,
    retryable: error.retryable,
    service: error.service,
    operation: error.operation,
    ...options.metadata
  })
  logErrorAtLevel(
    log,
    error.level,
    error.technicalMessage || error.message,
    details as object,
    error.stack
  )
  return {
    isSuccess: false,
    message: error.userMessage || fallbackMessage,
    ...(options.includeErrorInResponse && {
      error: { code: error.code, message: error.message, details }
    })
  }
}

function handleAppError(
  error: AppError,
  userMessage: string,
  options: ResolvedHandleErrorOptions,
  log: ErrorLog
): ActionState<never> {
  const details = sanitizeForLogging({
    details: error.details,
    ...options.metadata
  })
  logErrorAtLevel(log, error.level, error.message, details as object, error.stack)
  return errorResponse(userMessage, options.includeErrorInResponse, error)
}

function logErrorAtLevel(
  log: ErrorLog,
  level: ErrorLevel,
  message: string,
  details: object,
  stack?: string
): void {
  const safeMessage = sanitizeForLogging(message) as string
  if (level === ErrorLevel.INFO) {
    log.info(safeMessage, details)
    return
  }
  if (level === ErrorLevel.WARN) {
    log.warn(safeMessage, details)
    return
  }
  const prefix = level === ErrorLevel.FATAL ? "FATAL: " : ""
  log.error(`${prefix}${safeMessage}`, { ...details, stack })
}

function handleAggregateError(
  error: AggregateError,
  userMessage: string,
  options: ResolvedHandleErrorOptions,
  log: ErrorLog
): ActionState<never> {
  log.error(sanitizeForLogging(error.message) as string, {
    error: sanitizeForLogging(error),
    stack: error.stack,
    errors: Array.isArray(error.errors)
      ? error.errors.map(item => sanitizeForLogging(item))
      : undefined,
    ...options.metadata
  })
  return errorResponse(userMessage, options.includeErrorInResponse, error)
}

function handleStandardError(
  error: Error,
  userMessage: string,
  options: ResolvedHandleErrorOptions,
  log: ErrorLog
): ActionState<never> {
  log.error(sanitizeForLogging(error.message) as string, {
    error: sanitizeForLogging(error),
    stack: error.stack,
    ...options.metadata
  })
  return errorResponse(userMessage, options.includeErrorInResponse, error)
}

function handleUnknownError(
  error: unknown,
  userMessage: string,
  options: ResolvedHandleErrorOptions,
  log: ErrorLog
): ActionState<never> {
  log.error("Unknown error occurred", {
    error: sanitizeForLogging(error),
    ...options.metadata
  })
  return errorResponse(userMessage, options.includeErrorInResponse, error)
}

function errorResponse(
  message: string,
  includeError: boolean,
  error: unknown
): ActionState<never> {
  return {
    isSuccess: false,
    message,
    ...(includeError && { error })
  }
}

/**
 * Creates a success ActionState
 */
export function createSuccess<T>(data: T, message = "Operation successful"): ActionState<T> {
  return {
    isSuccess: true,
    message,
    data
  }
}

/**
 * Wraps an async function with error handling for API routes
 */
export async function withErrorHandling<T>(
  fn: () => Promise<T>,
  options?: Parameters<typeof handleError>[2]
): Promise<ActionState<T>> {
  try {
    const result = await fn()
    return createSuccess(result)
  } catch (error) {
    return handleError(error, undefined, options) as ActionState<T>
  }
}
