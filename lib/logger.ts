// Winston logger utility for structured, environment-aware logging with enhanced capabilities
// - Development: pretty, colorized logs to console with context
// - Production: Structured JSON logs for CloudWatch with full metadata
// - Features: Request ID tracking, user context, performance metrics, sensitive data filtering
// Usage: import logger, { createLogger, generateRequestId } from "@/lib/logger"

import winston, { Logger } from "winston"
import { nanoid } from "nanoid"
import { AsyncLocalStorage } from "node:async_hooks"

// Security: CodeQL-compliant log sanitization that breaks taint flow completely
function sanitizeForLogger(data: unknown): unknown {
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

  if (Array.isArray(data)) {
    // Create a new array with sanitized elements
    return data.map(item => sanitizeForLogger(item))
  }

  // Enhanced: Sanitize Error objects so message, name, and stack are safe
  if (typeof data === "object") {
    if (data instanceof Error) {
      // Make a new plain object with sanitized message/name/stack and all custom props
      const safeError: Record<string, unknown> = {}
      safeError.name = sanitizeForLogger(data.name)
      safeError.message = sanitizeForLogger(data.message)
      safeError.stack = typeof data.stack === "string" ? sanitizeForLogger(data.stack) : ""
      // Use Map to avoid any prototype pollution risks
      const customProps = new Map<string, unknown>()
      for (const key of Object.keys(data)) {
        if (!(key in safeError)) {
          const safeKey = String(key).replace(/[^\w.-]/g, '_')
          if (safeKey && safeKey !== '__proto__' && safeKey !== 'constructor' && safeKey !== 'prototype') {
            customProps.set(safeKey, sanitizeForLogger((data as unknown as Record<string, unknown>)[key]))
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
          propMap.set(cleanKey, sanitizeForLogger(value))
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

// AsyncLocalStorage for request context propagation
const asyncLocalStorage = new AsyncLocalStorage<LogContext>()

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
 */
function filterSensitiveData(data: unknown): unknown {
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
  
  if (Array.isArray(data)) {
    return data.map(filterSensitiveData)
  }
  
  if (data && typeof data === "object") {
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
        filteredValue = filterSensitiveData(value)
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
 */
export function getLogContext(): LogContext {
  return asyncLocalStorage.getStore() || {}
}

/**
 * Set or update the log context
 */
export function setLogContext(context: LogContext): void {
  const currentContext = getLogContext()
  asyncLocalStorage.enterWith({ ...currentContext, ...context })
}

/**
 * Run a function with a specific log context
 */
export async function withLogContext<T>(
  context: LogContext,
  fn: () => T | Promise<T>
): Promise<T> {
  return asyncLocalStorage.run(context, fn)
}

/**
 * Create a child logger with additional context
 * This maintains all parent context and adds new fields
 */
export function createLogger(context: LogContext): Logger {
  return {
    ...logger,
    info: (message: string, meta?: object) => {
      const safeMessage = sanitizeForLogger(message) as string
      const contextData = sanitizeForLogger({ ...getLogContext(), ...context }) as Record<string, unknown>
      const metaData = meta ? sanitizeForLogger(meta) as Record<string, unknown> : {}
      // Serialize to JSON and parse to break taint flow completely - prevents log injection
      const untaintedData = JSON.parse(JSON.stringify({ ...contextData, ...metaData }))
      const untaintedMessage = String(safeMessage).replace(/[\n\r]/g, ' ')
      logger.info(untaintedMessage, untaintedData)
    },
    warn: (message: string, meta?: object) => {
      const safeMessage = sanitizeForLogger(message) as string
      const contextData = sanitizeForLogger({ ...getLogContext(), ...context }) as Record<string, unknown>
      const metaData = meta ? sanitizeForLogger(meta) as Record<string, unknown> : {}
      const untaintedData = JSON.parse(JSON.stringify({ ...contextData, ...metaData }))
      const untaintedMessage = String(safeMessage).replace(/[\n\r]/g, ' ')
      logger.warn(untaintedMessage, untaintedData)
    },
    error: (message: string, meta?: object) => {
      const safeMessage = sanitizeForLogger(message) as string
      const contextData = sanitizeForLogger({ ...getLogContext(), ...context }) as Record<string, unknown>
      const metaData = meta ? sanitizeForLogger(meta) as Record<string, unknown> : {}
      const untaintedData = JSON.parse(JSON.stringify({ ...contextData, ...metaData }))
      const untaintedMessage = String(safeMessage).replace(/[\n\r]/g, ' ')
      logger.error(untaintedMessage, untaintedData)
    },
    debug: (message: string, meta?: object) => {
      const safeMessage = sanitizeForLogger(message) as string
      const contextData = sanitizeForLogger({ ...getLogContext(), ...context }) as Record<string, unknown>
      const metaData = meta ? sanitizeForLogger(meta) as Record<string, unknown> : {}
      const untaintedData = JSON.parse(JSON.stringify({ ...contextData, ...metaData }))
      const untaintedMessage = String(safeMessage).replace(/[\n\r]/g, ' ')
      logger.debug(untaintedMessage, untaintedData)
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