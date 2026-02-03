// Winston logger utility for structured, environment-aware logging with enhanced capabilities
// - Development: pretty, colorized logs to console with context
// - Production: Structured JSON logs for CloudWatch with full metadata
// - Features: Request ID tracking, user context, performance metrics, sensitive data filtering
// Usage: import logger, { createLogger, generateRequestId } from "@/lib/logger"

import winston, { Logger } from "winston"
import { nanoid } from "nanoid"

// Conditionally import AsyncLocalStorage only in Node.js runtime
// Edge Runtime doesn't support node:async_hooks
type AsyncLocalStorageType<T> = {
  getStore(): T | undefined
  enterWith(store: T): void
  run<R>(store: T, fn: () => R): R
}

let asyncLocalStorageModule: AsyncLocalStorageType<LogContext> | null = null

// Only import in Node.js runtime (not Edge)
// EdgeRuntime is defined in Edge Runtime environments
if (typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime === 'undefined') {
  try {
    // Dynamic require to avoid bundling in Edge Runtime
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AsyncLocalStorage } = require('node:async_hooks')
    asyncLocalStorageModule = new AsyncLocalStorage() as AsyncLocalStorageType<LogContext>
  } catch {
    // Silently fail - Edge Runtime or environment without async_hooks
  }
}

// Security: CodeQL-compliant log sanitization that breaks taint flow completely
// Enhanced with circular reference detection and depth limiting to prevent stack overflow
// Public API - creates WeakSet once at top level
function sanitizeForLogger(data: unknown): unknown {
  return sanitizeForLoggerInternal(data, 10, new WeakSet<object>())
}

// Private recursive implementation - WeakSet shared across all recursive calls
function sanitizeForLoggerInternal(data: unknown, maxDepth: number, seen: WeakSet<object>): unknown {
  if (data === null || data === undefined) {
    return data
  }

  if (typeof data === "string") {
    // CodeQL-compliant sanitization: explicit character allowlisting
    const safe = data
      .replace(/[^\u0020-\u007E]/g, '') // Only allow printable ASCII characters (space to tilde)
      .replace(/[\t\n\r]/g, ' ')    // Replace line breaks with spaces
      .substring(0, 1000)           // Explicit length limit to prevent log bloat
    return safe
  }

  if (typeof data === "number" || typeof data === "boolean") {
    // Create new primitives to break taint flow
    return typeof data === "number" ? Number(data) : Boolean(data)
  }

  // CRITICAL: Check depth limit BEFORE recursion to prevent stack overflow
  if (maxDepth <= 0) {
    return '[Max Depth Reached]'
  }

  if (Array.isArray(data)) {
    // CRITICAL: Circular reference detection for arrays
    if (seen.has(data)) {
      return '[Circular]'
    }
    seen.add(data)
    // Create a new array with sanitized elements
    return data.map(item => sanitizeForLoggerInternal(item, maxDepth - 1, seen))
  }

  // Enhanced: Sanitize Error objects so message, name, and stack are safe
  if (typeof data === "object") {
    // CRITICAL: Circular reference detection for objects
    if (seen.has(data)) {
      return '[Circular]'
    }
    seen.add(data)

    if (data instanceof Error) {
      // Make a new plain object with sanitized message/name/stack
      // DON'T recurse into Error.cause to prevent infinite error chains
      const safeError: Record<string, unknown> = {}
      safeError.name = sanitizeForLoggerInternal(data.name, maxDepth - 1, seen)
      safeError.message = sanitizeForLoggerInternal(data.message, maxDepth - 1, seen)
      safeError.stack = typeof data.stack === "string" ? sanitizeForLoggerInternal(data.stack, maxDepth - 1, seen) : ""
      // Use Map to avoid any prototype pollution risks
      const customProps = new Map<string, unknown>()
      for (const key of Object.keys(data)) {
        // Skip 'cause' property to prevent infinite error chains
        if (key === 'cause') {
          continue
        }
        if (!(key in safeError)) {
          const safeKey = String(key).replace(/[^\w.-]/g, '_')
          if (safeKey && safeKey !== '__proto__' && safeKey !== 'constructor' && safeKey !== 'prototype') {
            customProps.set(safeKey, sanitizeForLoggerInternal((data as unknown as Record<string, unknown>)[key], maxDepth - 1, seen))
          }
        }
      }
      // Convert Map to plain object safely
      if (customProps.size > 0) {
        safeError.customProperties = Object.fromEntries(customProps)
      }
      return safeError
    } else {
      // Use Map to avoid prototype pollution completely
      const propMap = new Map<string, unknown>()
      for (const [key, value] of Object.entries(data)) {
        const cleanKey = String(key).replace(/[^\w.-]/g, '_')
        if (cleanKey && cleanKey !== '__proto__' && cleanKey !== 'constructor' && cleanKey !== 'prototype') {
          propMap.set(cleanKey, sanitizeForLoggerInternal(value, maxDepth - 1, seen))
        }
      }
      return Object.fromEntries(propMap)
    }
  }

  // Fallback for unknown types - create new safe string
  return String(data).slice(0, 100)
}

const isProd = process.env.NODE_ENV === "production"
const isTest = process.env.NODE_ENV === "test"

// asyncLocalStorageModule is initialized at the top of the file conditionally

// Log context interface for structured metadata
export interface LogContext {
  requestId?: string
  userId?: string
  userEmail?: string
  action?: string
  route?: string
  method?: string
  duration?: number
  sessionId?: string
  environment?: string
  version?: string
  region?: string
  [key: string]: unknown
}

// Sensitive data patterns to filter from logs
const SENSITIVE_PATTERNS = [
  /password[\s"]*[:=]\s*["']?[^\s"',}]+/gi,
  /token[\s"]*[:=]\s*["']?[^\s"',}]+/gi,
  /api[_-]?key[\s"]*[:=]\s*["']?[^\s"',}]+/gi,
  /secret[\s"]*[:=]\s*["']?[^\s"',}]+/gi,
  /authorization[\s"]*[:=]\s*["']?bearer\s+[^\s"',}]+/gi,
  /cognito[_-]?sub[\s"]*[:=]\s*["']?[^\s"',}]+/gi,
]

// Email masking pattern (show domain only) - using simpler non-backtracking pattern
const EMAIL_PATTERN = /\b[\dA-Za-z][\w%+.-]*@([\dA-Za-z][\d.A-Za-z-]*\.[A-Za-z]{2,})\b/g

/**
 * Filters sensitive data from log messages and metadata
 * Enhanced with depth limiting and circular reference detection
 * Public API - creates WeakSet once at top level
 */
function filterSensitiveData(data: unknown): unknown {
  return filterSensitiveDataInternal(data, 10, new WeakSet<object>())
}

// Private recursive implementation - WeakSet shared across all recursive calls
function filterSensitiveDataInternal(data: unknown, maxDepth: number, seen: WeakSet<object>): unknown {
  if (typeof data === "string") {
    let filtered = data
    // Filter out sensitive patterns
    for (const pattern of SENSITIVE_PATTERNS) {
      filtered = filtered.replace(pattern, "[REDACTED]")
    }
    // Mask email addresses (keep domain for debugging)
    filtered = filtered.replace(EMAIL_PATTERN, "***@$1")
    return filtered
  }

  // CRITICAL: Check depth limit to prevent stack overflow
  if (maxDepth <= 0) {
    return '[Max Depth Reached]'
  }

  if (Array.isArray(data)) {
    // CRITICAL: Circular reference detection
    if (seen.has(data)) {
      return '[Circular]'
    }
    seen.add(data)
    return data.map(item => filterSensitiveDataInternal(item, maxDepth - 1, seen))
  }

  if (data && typeof data === "object") {
    // CRITICAL: Circular reference detection
    if (seen.has(data)) {
      return '[Circular]'
    }
    seen.add(data)

    const propMap = new Map<string, unknown>()
    for (const [key, value] of Object.entries(data)) {
      const cleanKey = String(key).replace(/[^\w.-]/g, '_')
      if (!cleanKey || cleanKey === '__proto__' || cleanKey === 'constructor' || cleanKey === 'prototype') {
        continue
      }

      const lowerKey = cleanKey.toLowerCase()
      let filteredValue: unknown

      if (lowerKey.includes("password") ||
          lowerKey.includes("token") ||
          lowerKey.includes("secret") ||
          lowerKey.includes("apikey") ||
          lowerKey.includes("api_key")) {
        filteredValue = "[REDACTED]"
      } else if (lowerKey.includes("email")) {
        filteredValue = typeof value === "string"
          ? value.replace(EMAIL_PATTERN, "***@$1")
          : value
      } else {
        filteredValue = filterSensitiveDataInternal(value, maxDepth - 1, seen)
      }

      propMap.set(cleanKey, filteredValue)
    }
    return Object.fromEntries(propMap)
  }

  return data
}

/**
 * Custom format for development environment
 */
const devFormat = winston.format.printf(({ timestamp, level, message, ...meta }) => {
  const context = getLogContext()
  const allMeta = { ...context, ...meta }
  
  // Filter sensitive data in dev
  const filteredMeta = filterSensitiveData(allMeta)
  const metaString = Object.keys(filteredMeta as object).length > 0 
    ? `\n${JSON.stringify(filteredMeta, null, 2)}` 
    : ""
  
  const requestId = context?.requestId ? `[${context.requestId}] ` : ""
  return `${timestamp} ${requestId}${level}: ${message}${metaString}`
})

/**
 * Custom format for production - structured JSON with metadata
 */
// Type for log entry with optional stack trace
interface LogEntryWithStack extends Record<string, unknown> {
  timestamp: string
  level: string
  message: string
  environment: string
  version: string
  region: string
  stack?: string
}

const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.printf((info) => {
    const context = getLogContext()
    const { timestamp, level, message, stack, ...meta } = info
    
    const logEntry: LogEntryWithStack = {
      timestamp: timestamp as string,
      level: level as string,
      message: message as string,
      ...context,
      ...meta,
      environment: process.env.NODE_ENV || "development",
      version: process.env.APP_VERSION || "unknown",
      region: process.env.AWS_REGION || "unknown",
    }
    
    if (stack) {
      logEntry.stack = stack as string
    }
    
    // Filter sensitive data in production
    return JSON.stringify(filterSensitiveData(logEntry))
  })
)

// Main logger instance
const logger: Logger = winston.createLogger({
  level: isTest ? "error" : (isProd ? "info" : "debug"),
  format: isProd ? prodFormat : winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    devFormat
  ),
  transports: [new winston.transports.Console()],
  // Prevent unhandled promise rejections from crashing in production
  exitOnError: !isProd,
})

/**
 * Generate a unique request ID using nanoid
 */
export function generateRequestId(): string {
  return nanoid(10)
}

/**
 * Get the current log context from AsyncLocalStorage
 * Returns empty context in Edge Runtime where AsyncLocalStorage is unavailable
 */
export function getLogContext(): LogContext {
  return asyncLocalStorageModule?.getStore() || {}
}

/**
 * Set or update the log context
 * No-op in Edge Runtime where AsyncLocalStorage is unavailable
 */
export function setLogContext(context: LogContext): void {
  if (!asyncLocalStorageModule) return
  const currentContext = getLogContext()
  asyncLocalStorageModule.enterWith({ ...currentContext, ...context })
}

/**
 * Run a function with a specific log context
 * Falls back to direct execution in Edge Runtime
 */
export async function withLogContext<T>(
  context: LogContext,
  fn: () => T | Promise<T>
): Promise<T> {
  if (!asyncLocalStorageModule) return fn()
  return asyncLocalStorageModule.run(context, fn)
}

/**
 * Sanitizes log messages to prevent log injection attacks
 * This function acts as a CodeQL barrier for taint tracking
 * Explicitly removes newlines and control characters per CodeQL guidance
 *
 * @param input - The message to sanitize
 * @returns Sanitized string safe for logging
 */
function sanitizeLogMessage(input: unknown): string {
  // Convert to string if needed
  let str = typeof input === 'string' ? input : String(input)

  // Explicitly remove characters that could forge log entries
  // This follows CodeQL log injection prevention guidance

  // Replace newlines with spaces
  str = str.replace(/[\n\r]/g, ' ')

  // Remove control characters (0x00-0x1F and 0x7F)
  // Using String.fromCharCode to avoid eslint no-control-regex warning
  const controlCharsPattern = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
    'g'
  )
  str = str.replace(controlCharsPattern, '')

  // Limit length to prevent log bloat
  str = str.substring(0, 1000)

  return str
}

/**
 * Sanitizes metadata objects for safe logging
 * Removes sensitive data and prevents injection attacks
 *
 * @param data - The metadata to sanitize
 * @returns Sanitized metadata object
 */
function sanitizeLogMetadata(data: unknown): Record<string, unknown> {
  // First remove sensitive data
  const filtered = filterSensitiveData(data)
  // Then sanitize for CodeQL (removes taint)
  const sanitized = sanitizeForLogger(filtered)
  // Return as typed object
  return sanitized as Record<string, unknown>
}

/**
 * Create a child logger with additional context
 * This maintains all parent context and adds new fields
 */
export function createLogger(context: LogContext): Logger {
  return {
    ...logger,
    info: (message: string, meta?: object) => {
      // Sanitize message to prevent log injection
      const cleanMessage = sanitizeLogMessage(message)
      // Combine and sanitize metadata
      const cleanMeta = sanitizeLogMetadata({ ...getLogContext(), ...context, ...meta })
      logger.info(cleanMessage, cleanMeta)
    },
    warn: (message: string, meta?: object) => {
      // Sanitize message to prevent log injection
      const cleanMessage = sanitizeLogMessage(message)
      // Combine and sanitize metadata
      const cleanMeta = sanitizeLogMetadata({ ...getLogContext(), ...context, ...meta })
      logger.warn(cleanMessage, cleanMeta)
    },
    error: (message: string, meta?: object) => {
      // Sanitize message to prevent log injection
      const cleanMessage = sanitizeLogMessage(message)
      // Combine and sanitize metadata
      const cleanMeta = sanitizeLogMetadata({ ...getLogContext(), ...context, ...meta })
      logger.error(cleanMessage, cleanMeta)
    },
    debug: (message: string, meta?: object) => {
      // Sanitize message to prevent log injection
      const cleanMessage = sanitizeLogMessage(message)
      // Combine and sanitize metadata
      const cleanMeta = sanitizeLogMetadata({ ...getLogContext(), ...context, ...meta })
      logger.debug(cleanMessage, cleanMeta)
    },
  } as Logger
}

/**
 * Helper to create a child logger with request ID (backward compatible)
 * @deprecated Use createLogger({ requestId }) instead
 */
export function withRequestId(requestId: string): Logger {
  return createLogger({ requestId })
}

/**
 * Sanitize data for logging (removes sensitive fields)
 */
export function sanitizeForLogging(data: unknown): unknown {
  return filterSensitiveData(sanitizeForLogger(data))
}

/**
 * Log performance metrics for an operation
 */
export function logPerformance(
  operation: string,
  startTime: number,
  metadata?: object
): void {
  const duration = Date.now() - startTime
  const context = getLogContext()
  
  logger.info(`Performance: ${operation}`, {
    ...context,
    operation,
    duration,
    ...metadata,
  })
}

/**
 * Create a performance timer for measuring operation duration
 */
export function startTimer(operation: string): (metadata?: object) => void {
  const startTime = Date.now()
  return (metadata?: object) => {
    logPerformance(operation, startTime, metadata)
  }
}

export default logger 