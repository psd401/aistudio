/**
 * Edge Runtime compatible logger for authentication modules
 *
 * This logger is designed to work in Edge Runtime environments where Node.js APIs
 * are not available. It provides structured logging that can be captured by
 * monitoring systems without violating Edge Runtime constraints.
 *
 * Security Note: In production, token metadata logging is sanitized to prevent
 * potential information disclosure through logs.
 */

interface EdgeLogger {
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: Record<string, unknown>) => void
  debug: (message: string, meta?: Record<string, unknown>) => void
}

interface LogContext {
  context: string
  tokenSub?: string
  [key: string]: unknown
}

// No global state - each logger instance is self-contained

/**
 * Creates an Edge Runtime compatible logger instance
 *
 * @param context - Logging context including module name and optional token identifier
 * @returns EdgeLogger instance with info, warn, error, and debug methods
 */
export function createEdgeLogger(context: LogContext): EdgeLogger {
  // Sanitize token sub in production to prevent information disclosure
  const sanitizedTokenSub = process.env.NODE_ENV === 'production' && context.tokenSub
    ? context.tokenSub.substring(0, 8) + '***'
    : context.tokenSub || 'unknown'

  /**
   * Sanitizes metadata to prevent sensitive information leakage in logs
   * Removes or truncates potentially sensitive fields
   */
  const sanitizeMetadata = (meta?: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (!meta) return undefined

    const sanitized: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(meta)) {
      // Don't log actual token values or sensitive data
      if (key.toLowerCase().includes('token') && typeof value === 'string' && value.length > 20) {
        sanitized[key] = '[REDACTED_TOKEN]'
      } else if (key === 'tokenSub' && typeof value === 'string' && process.env.NODE_ENV === 'production') {
        sanitized[key] = value.substring(0, 8) + '***'
      } else if (key === 'error' && typeof value === 'string') {
        // Sanitize error messages that might contain tokens
        sanitized[key] = value.replace(/[\d+/=A-Za-z]{20,}/g, '[REDACTED_TOKEN]')
      } else {
        sanitized[key] = value
      }
    }

    return sanitized
  }

  const logMessage = (level: string, message: string, meta?: Record<string, unknown>) => {
    const timestamp = new Date().toISOString()
    const contextString = `${context.context}[${sanitizedTokenSub}]`
    const sanitizedMeta = sanitizeMetadata(meta)

    // In development, attempt to output to available logging mechanism
    if (process.env.NODE_ENV === 'development') {
      try {
        const formattedMessage = `[${timestamp}] ${contextString} ${level}: ${message}`
        const metaString = sanitizedMeta ? ` ${JSON.stringify(sanitizedMeta)}` : ''

        // Try to use fetch to send to a logging endpoint if available
        // This is Edge Runtime compatible
        if (process.env.DEBUG_LOG_ENDPOINT) {
          const logEntry = {
            level,
            message,
            timestamp,
            context: contextString,
            meta: sanitizedMeta
          }

          fetch(process.env.DEBUG_LOG_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(logEntry)
          }).catch(() => {
            // Silently fail if logging endpoint unavailable
          })
        }

        // For development debugging - works in both Node.js and Edge Runtime
        // eslint-disable-next-line no-console
        if (level === 'ERROR') {
          // eslint-disable-next-line no-console
          console.error(`${formattedMessage}${metaString}`)
        } else {
          // eslint-disable-next-line no-console
          console.log(`${formattedMessage}${metaString}`)
        }
      } catch {
        // Silently fail if any logging mechanism fails
        // This ensures the logger never breaks the application
      }
    }
  }

  return {
    info: (message: string, meta?: Record<string, unknown>) => {
      logMessage('INFO', message, meta)
    },

    warn: (message: string, meta?: Record<string, unknown>) => {
      logMessage('WARN', message, meta)
    },

    error: (message: string, meta?: Record<string, unknown>) => {
      logMessage('ERROR', message, meta)
    },

    debug: (message: string, meta?: Record<string, unknown>) => {
      // Only log debug messages in development to reduce production overhead
      if (process.env.NODE_ENV === 'development') {
        logMessage('DEBUG', message, meta)
      }
    }
  }
}

/**
 * Alias for createEdgeLogger to maintain compatibility with existing createLogger calls
 * This allows existing code to use the same function name while getting Edge Runtime compatibility
 */
export const createLogger = createEdgeLogger