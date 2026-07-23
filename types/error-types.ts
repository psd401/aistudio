/**
 * Standardized error types and codes for consistent error handling and logging
 * These types provide a comprehensive categorization system for all application errors
 */

import { ErrorLevel } from "./actions-types"

/**
 * Error code enumeration for categorizing different types of errors
 * Organized by domain: Authentication, Authorization, Database, Validation, External Services, Business Logic
 */
export enum ErrorCode {
  // Authentication Errors (AUTH_*)
  AUTH_NO_SESSION = "AUTH_NO_SESSION",
  AUTH_INVALID_TOKEN = "AUTH_INVALID_TOKEN",
  AUTH_EXPIRED_SESSION = "AUTH_EXPIRED_SESSION",
  AUTH_INVALID_CREDENTIALS = "AUTH_INVALID_CREDENTIALS",
  AUTH_COGNITO_ERROR = "AUTH_COGNITO_ERROR",
  AUTH_TOKEN_REFRESH_FAILED = "AUTH_TOKEN_REFRESH_FAILED",
  
  // Authorization Errors (AUTHZ_*)
  AUTHZ_INSUFFICIENT_PERMISSIONS = "AUTHZ_INSUFFICIENT_PERMISSIONS",
  AUTHZ_RESOURCE_NOT_FOUND = "AUTHZ_RESOURCE_NOT_FOUND",
  AUTHZ_ROLE_NOT_ASSIGNED = "AUTHZ_ROLE_NOT_ASSIGNED",
  AUTHZ_TOOL_ACCESS_DENIED = "AUTHZ_TOOL_ACCESS_DENIED",
  AUTHZ_ADMIN_REQUIRED = "AUTHZ_ADMIN_REQUIRED",
  AUTHZ_OWNER_REQUIRED = "AUTHZ_OWNER_REQUIRED",
  
  // Database Errors (DB_*)
  DB_CONNECTION_FAILED = "DB_CONNECTION_FAILED",
  DB_QUERY_FAILED = "DB_QUERY_FAILED",
  DB_CONSTRAINT_VIOLATION = "DB_CONSTRAINT_VIOLATION",
  DB_TRANSACTION_FAILED = "DB_TRANSACTION_FAILED",
  DB_DUPLICATE_ENTRY = "DB_DUPLICATE_ENTRY",
  DB_RECORD_NOT_FOUND = "DB_RECORD_NOT_FOUND",
  DB_TIMEOUT = "DB_TIMEOUT",
  DB_POOL_EXHAUSTED = "DB_POOL_EXHAUSTED",
  
  // Validation Errors (VALIDATION_*)
  VALIDATION_FAILED = "VALIDATION_FAILED",
  INVALID_INPUT = "INVALID_INPUT",
  MISSING_REQUIRED_FIELD = "MISSING_REQUIRED_FIELD",
  INVALID_FORMAT = "INVALID_FORMAT",
  VALUE_OUT_OF_RANGE = "VALUE_OUT_OF_RANGE",
  INVALID_FILE_TYPE = "INVALID_FILE_TYPE",
  FILE_TOO_LARGE = "FILE_TOO_LARGE",
  
  // External Service Errors (EXTERNAL_*)
  EXTERNAL_SERVICE_ERROR = "EXTERNAL_SERVICE_ERROR",
  EXTERNAL_SERVICE_TIMEOUT = "EXTERNAL_SERVICE_TIMEOUT",
  EXTERNAL_API_RATE_LIMIT = "EXTERNAL_API_RATE_LIMIT",
  EXTERNAL_API_INVALID_RESPONSE = "EXTERNAL_API_INVALID_RESPONSE",
  AWS_SERVICE_ERROR = "AWS_SERVICE_ERROR",
  S3_UPLOAD_FAILED = "S3_UPLOAD_FAILED",
  S3_DOWNLOAD_FAILED = "S3_DOWNLOAD_FAILED",
  LAMBDA_INVOCATION_FAILED = "LAMBDA_INVOCATION_FAILED",
  
  // Business Logic Errors (BIZ_*)
  BIZ_INVALID_STATE = "BIZ_INVALID_STATE",
  BIZ_OPERATION_NOT_ALLOWED = "BIZ_OPERATION_NOT_ALLOWED",
  BIZ_QUOTA_EXCEEDED = "BIZ_QUOTA_EXCEEDED",
  BIZ_DUPLICATE_OPERATION = "BIZ_DUPLICATE_OPERATION",
  BIZ_DEPENDENCY_ERROR = "BIZ_DEPENDENCY_ERROR",
  
  // System Errors (SYS_*)
  SYS_INTERNAL_ERROR = "SYS_INTERNAL_ERROR",
  SYS_CONFIGURATION_ERROR = "SYS_CONFIGURATION_ERROR",
  SYS_ENVIRONMENT_ERROR = "SYS_ENVIRONMENT_ERROR",
  SYS_MEMORY_ERROR = "SYS_MEMORY_ERROR",
  SYS_DISK_ERROR = "SYS_DISK_ERROR",
}

/**
 * Extended error interface with additional context for logging and handling
 */
export interface TypedError extends Error {
  code: ErrorCode
  level: ErrorLevel
  details?: Record<string, unknown>
  statusCode?: number
  retryable?: boolean
  userMessage?: string
  technicalMessage?: string
  correlationId?: string
  timestamp?: string
  service?: string
  operation?: string
}

/**
 * Database-specific error with query context
 */
export interface DatabaseError extends TypedError {
  code: ErrorCode.DB_CONNECTION_FAILED | 
        ErrorCode.DB_QUERY_FAILED | 
        ErrorCode.DB_CONSTRAINT_VIOLATION | 
        ErrorCode.DB_TRANSACTION_FAILED |
        ErrorCode.DB_DUPLICATE_ENTRY |
        ErrorCode.DB_RECORD_NOT_FOUND |
        ErrorCode.DB_TIMEOUT |
        ErrorCode.DB_POOL_EXHAUSTED
  query?: string
  parameters?: unknown[]
  table?: string
  constraint?: string
  affectedRows?: number
}

/**
 * Authentication error with auth context
 */
export interface AuthenticationError extends TypedError {
  code: ErrorCode.AUTH_NO_SESSION | 
        ErrorCode.AUTH_INVALID_TOKEN | 
        ErrorCode.AUTH_EXPIRED_SESSION |
        ErrorCode.AUTH_INVALID_CREDENTIALS |
        ErrorCode.AUTH_COGNITO_ERROR |
        ErrorCode.AUTH_TOKEN_REFRESH_FAILED
  authMethod?: string
  userId?: string
  sessionId?: string
  expiresAt?: string
}

/**
 * Authorization error with permission context
 */
export interface AuthorizationError extends TypedError {
  code: ErrorCode.AUTHZ_INSUFFICIENT_PERMISSIONS | 
        ErrorCode.AUTHZ_RESOURCE_NOT_FOUND |
        ErrorCode.AUTHZ_ROLE_NOT_ASSIGNED |
        ErrorCode.AUTHZ_TOOL_ACCESS_DENIED |
        ErrorCode.AUTHZ_ADMIN_REQUIRED |
        ErrorCode.AUTHZ_OWNER_REQUIRED
  requiredRole?: string
  requiredPermission?: string
  userRoles?: string[]
  resourceId?: string
  resourceType?: string
}

/**
 * Validation error with field-level details
 */
export interface ValidationError extends TypedError {
  code: ErrorCode.VALIDATION_FAILED | 
        ErrorCode.INVALID_INPUT |
        ErrorCode.MISSING_REQUIRED_FIELD |
        ErrorCode.INVALID_FORMAT |
        ErrorCode.VALUE_OUT_OF_RANGE |
        ErrorCode.INVALID_FILE_TYPE |
        ErrorCode.FILE_TOO_LARGE
  fields?: Array<{
    field: string
    value?: unknown
    message: string
    constraint?: string
  }>
}

/**
 * External service error with service details
 */
export interface ExternalServiceError extends TypedError {
  code: ErrorCode.EXTERNAL_SERVICE_ERROR | 
        ErrorCode.EXTERNAL_SERVICE_TIMEOUT |
        ErrorCode.EXTERNAL_API_RATE_LIMIT |
        ErrorCode.EXTERNAL_API_INVALID_RESPONSE |
        ErrorCode.AWS_SERVICE_ERROR |
        ErrorCode.S3_UPLOAD_FAILED |
        ErrorCode.S3_DOWNLOAD_FAILED |
        ErrorCode.LAMBDA_INVOCATION_FAILED
  serviceName: string
  endpoint?: string
  statusCode?: number
  responseTime?: number
  retryCount?: number
  nextRetryAt?: string
}

/**
 * Business logic error with operation context
 */
export interface BusinessLogicError extends TypedError {
  code: ErrorCode.BIZ_INVALID_STATE | 
        ErrorCode.BIZ_OPERATION_NOT_ALLOWED |
        ErrorCode.BIZ_QUOTA_EXCEEDED |
        ErrorCode.BIZ_DUPLICATE_OPERATION |
        ErrorCode.BIZ_DEPENDENCY_ERROR
  operation: string
  currentState?: string
  expectedState?: string
  quota?: {
    limit: number
    current: number
    resetAt?: string
  }
}

/**
 * Helper type guards for error type checking
 */
export function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof Error && 
         "code" in error && 
         (error as TypedError).code.startsWith("DB_")
}

export function isAuthenticationError(error: unknown): error is AuthenticationError {
  return error instanceof Error && 
         "code" in error && 
         (error as TypedError).code.startsWith("AUTH_")
}

export function isAuthorizationError(error: unknown): error is AuthorizationError {
  return error instanceof Error && 
         "code" in error && 
         (error as TypedError).code.startsWith("AUTHZ_")
}

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof Error && 
         "code" in error && 
         ((error as TypedError).code.startsWith("VALIDATION_") || 
          (error as TypedError).code === ErrorCode.INVALID_INPUT ||
          (error as TypedError).code === ErrorCode.MISSING_REQUIRED_FIELD ||
          (error as TypedError).code === ErrorCode.INVALID_FORMAT ||
          (error as TypedError).code === ErrorCode.VALUE_OUT_OF_RANGE ||
          (error as TypedError).code === ErrorCode.INVALID_FILE_TYPE ||
          (error as TypedError).code === ErrorCode.FILE_TOO_LARGE)
}

export function isExternalServiceError(error: unknown): error is ExternalServiceError {
  return error instanceof Error && 
         "code" in error && 
         ((error as TypedError).code.startsWith("EXTERNAL_") ||
          (error as TypedError).code.startsWith("AWS_") ||
          (error as TypedError).code.startsWith("S3_") ||
          (error as TypedError).code === ErrorCode.LAMBDA_INVOCATION_FAILED)
}

export function isBusinessLogicError(error: unknown): error is BusinessLogicError {
  return error instanceof Error && 
         "code" in error && 
         (error as TypedError).code.startsWith("BIZ_")
}

/**
 * Map error codes to appropriate HTTP status codes
 */
export const ERROR_STATUS_CODES: Record<ErrorCode, number> = {
  // 400 Bad Request
  [ErrorCode.VALIDATION_FAILED]: 400,
  [ErrorCode.INVALID_INPUT]: 400,
  [ErrorCode.MISSING_REQUIRED_FIELD]: 400,
  [ErrorCode.INVALID_FORMAT]: 400,
  [ErrorCode.VALUE_OUT_OF_RANGE]: 400,
  [ErrorCode.INVALID_FILE_TYPE]: 400,
  [ErrorCode.FILE_TOO_LARGE]: 400,
  [ErrorCode.BIZ_INVALID_STATE]: 400,
  [ErrorCode.BIZ_DUPLICATE_OPERATION]: 400,
  
  // 401 Unauthorized
  [ErrorCode.AUTH_NO_SESSION]: 401,
  [ErrorCode.AUTH_INVALID_TOKEN]: 401,
  [ErrorCode.AUTH_EXPIRED_SESSION]: 401,
  [ErrorCode.AUTH_INVALID_CREDENTIALS]: 401,
  [ErrorCode.AUTH_TOKEN_REFRESH_FAILED]: 401,
  
  // 403 Forbidden
  [ErrorCode.AUTHZ_INSUFFICIENT_PERMISSIONS]: 403,
  [ErrorCode.AUTHZ_ROLE_NOT_ASSIGNED]: 403,
  [ErrorCode.AUTHZ_TOOL_ACCESS_DENIED]: 403,
  [ErrorCode.AUTHZ_ADMIN_REQUIRED]: 403,
  [ErrorCode.AUTHZ_OWNER_REQUIRED]: 403,
  [ErrorCode.BIZ_OPERATION_NOT_ALLOWED]: 403,
  
  // 404 Not Found
  [ErrorCode.AUTHZ_RESOURCE_NOT_FOUND]: 404,
  [ErrorCode.DB_RECORD_NOT_FOUND]: 404,
  
  // 409 Conflict
  [ErrorCode.DB_DUPLICATE_ENTRY]: 409,
  [ErrorCode.DB_CONSTRAINT_VIOLATION]: 409,
  
  // 429 Too Many Requests
  [ErrorCode.EXTERNAL_API_RATE_LIMIT]: 429,
  [ErrorCode.BIZ_QUOTA_EXCEEDED]: 429,
  
  // 500 Internal Server Error
  [ErrorCode.DB_CONNECTION_FAILED]: 500,
  [ErrorCode.DB_QUERY_FAILED]: 500,
  [ErrorCode.DB_TRANSACTION_FAILED]: 500,
  [ErrorCode.AUTH_COGNITO_ERROR]: 500,
  [ErrorCode.EXTERNAL_SERVICE_ERROR]: 500,
  [ErrorCode.AWS_SERVICE_ERROR]: 500,
  [ErrorCode.S3_UPLOAD_FAILED]: 500,
  [ErrorCode.S3_DOWNLOAD_FAILED]: 500,
  [ErrorCode.LAMBDA_INVOCATION_FAILED]: 500,
  [ErrorCode.BIZ_DEPENDENCY_ERROR]: 500,
  [ErrorCode.SYS_INTERNAL_ERROR]: 500,
  [ErrorCode.SYS_CONFIGURATION_ERROR]: 500,
  [ErrorCode.SYS_ENVIRONMENT_ERROR]: 500,
  [ErrorCode.SYS_MEMORY_ERROR]: 500,
  [ErrorCode.SYS_DISK_ERROR]: 500,
  
  // 503 Service Unavailable
  [ErrorCode.DB_TIMEOUT]: 503,
  [ErrorCode.DB_POOL_EXHAUSTED]: 503,
  [ErrorCode.EXTERNAL_SERVICE_TIMEOUT]: 503,
  [ErrorCode.EXTERNAL_API_INVALID_RESPONSE]: 503,
}

/**
 * Get user-friendly message for error code
 */
export function getUserMessage(code: ErrorCode): string {
  const messages: Record<ErrorCode, string> = {
    // Authentication
    [ErrorCode.AUTH_NO_SESSION]: "Please sign in to continue",
    [ErrorCode.AUTH_INVALID_TOKEN]: "Your session is invalid. Please sign in again",
    [ErrorCode.AUTH_EXPIRED_SESSION]: "Your session has expired. Please sign in again",
    [ErrorCode.AUTH_INVALID_CREDENTIALS]: "Invalid email or password",
    [ErrorCode.AUTH_COGNITO_ERROR]: "Authentication service is temporarily unavailable",
    [ErrorCode.AUTH_TOKEN_REFRESH_FAILED]: "Failed to refresh your session. Please sign in again",
    
    // Authorization
    [ErrorCode.AUTHZ_INSUFFICIENT_PERMISSIONS]: "You don't have permission to perform this action",
    [ErrorCode.AUTHZ_RESOURCE_NOT_FOUND]: "The requested resource was not found or you don't have access to it",
    [ErrorCode.AUTHZ_ROLE_NOT_ASSIGNED]: "Your account doesn't have the required role for this action",
    // Code name kept stable (referenced at 25+ call sites); message updated to
    // capability-neutral wording for the tools -> capabilities migration (#928).
    [ErrorCode.AUTHZ_TOOL_ACCESS_DENIED]: "You don't have access to this feature",
    [ErrorCode.AUTHZ_ADMIN_REQUIRED]: "Administrator privileges are required for this action",
    [ErrorCode.AUTHZ_OWNER_REQUIRED]: "Only the owner can perform this action",
    
    // Database
    [ErrorCode.DB_CONNECTION_FAILED]: "Unable to connect to the database. Please try again later",
    [ErrorCode.DB_QUERY_FAILED]: "Failed to retrieve data. Please try again",
    [ErrorCode.DB_CONSTRAINT_VIOLATION]: "This operation violates data integrity rules",
    [ErrorCode.DB_TRANSACTION_FAILED]: "Failed to complete the operation. Please try again",
    [ErrorCode.DB_DUPLICATE_ENTRY]: "This item already exists",
    [ErrorCode.DB_RECORD_NOT_FOUND]: "The requested item was not found",
    [ErrorCode.DB_TIMEOUT]: "The database operation timed out. Please try again",
    [ErrorCode.DB_POOL_EXHAUSTED]: "The service is currently overloaded. Please try again in a moment",
    
    // Validation
    [ErrorCode.VALIDATION_FAILED]: "Please check your input and try again",
    [ErrorCode.INVALID_INPUT]: "The provided input is invalid",
    [ErrorCode.MISSING_REQUIRED_FIELD]: "Please fill in all required fields",
    [ErrorCode.INVALID_FORMAT]: "The input format is incorrect",
    [ErrorCode.VALUE_OUT_OF_RANGE]: "The value is outside the allowed range",
    [ErrorCode.INVALID_FILE_TYPE]: "This file type is not supported",
    [ErrorCode.FILE_TOO_LARGE]: "The file is too large. Please choose a smaller file",
    
    // External Services
    [ErrorCode.EXTERNAL_SERVICE_ERROR]: "An external service is temporarily unavailable",
    [ErrorCode.EXTERNAL_SERVICE_TIMEOUT]: "The external service didn't respond in time",
    [ErrorCode.EXTERNAL_API_RATE_LIMIT]: "Too many requests. Please wait a moment and try again",
    [ErrorCode.EXTERNAL_API_INVALID_RESPONSE]: "Received an invalid response from the external service",
    [ErrorCode.AWS_SERVICE_ERROR]: "AWS service encountered an error",
    [ErrorCode.S3_UPLOAD_FAILED]: "Failed to upload the file. Please try again",
    [ErrorCode.S3_DOWNLOAD_FAILED]: "Failed to download the file. Please try again",
    [ErrorCode.LAMBDA_INVOCATION_FAILED]: "Failed to process your request",
    
    // Business Logic
    [ErrorCode.BIZ_INVALID_STATE]: "This operation cannot be performed in the current state",
    [ErrorCode.BIZ_OPERATION_NOT_ALLOWED]: "This operation is not allowed",
    [ErrorCode.BIZ_QUOTA_EXCEEDED]: "You have exceeded your quota. Please upgrade or wait for reset",
    [ErrorCode.BIZ_DUPLICATE_OPERATION]: "This operation has already been performed",
    [ErrorCode.BIZ_DEPENDENCY_ERROR]: "Cannot complete this operation due to dependency issues",
    
    // System
    [ErrorCode.SYS_INTERNAL_ERROR]: "An internal error occurred. Please try again later",
    [ErrorCode.SYS_CONFIGURATION_ERROR]: "System configuration error. Please contact support",
    [ErrorCode.SYS_ENVIRONMENT_ERROR]: "Environment error. Please contact support",
    [ErrorCode.SYS_MEMORY_ERROR]: "System memory error. Please try again later",
    [ErrorCode.SYS_DISK_ERROR]: "System storage error. Please try again later",
  }
  
  return messages[code] || "An unexpected error occurred. Please try again"
}