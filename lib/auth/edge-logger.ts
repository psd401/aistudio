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
    const formattedMessage = `[${timestamp}] ${contextString} ${level}: ${message}`
    const metaString = sanitizedMeta ? ` ${JSON.stringify(sanitizedMeta)}` : ''

    try {
      // Forward to the optional log endpoint in EVERY environment (Edge-compatible).
      if (process.env.DEBUG_LOG_ENDPOINT) {
        fetch(process.env.DEBUG_LOG_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            level,
            message,
            timestamp,
            context: contextString,
            meta: sanitizedMeta
          })
        }).catch(() => {
          // Silently fail if logging endpoint unavailable
        })
      }

      // warn/error MUST be visible in production. This logger was previously silent
      // outside development, dropping every Edge-runtime auth/token-refresh failure
      // (REV-COR-513). Metadata is already sanitized (sanitizeMetadata + tokenSub
      // truncation), so tokens are never emitted. info/debug stay development-only.
      if (level === 'ERROR') {
        // eslint-disable-next-line no-console
        console.error(`${formattedMessage}${metaString}`)
      } else if (level === 'WARN') {
        // eslint-disable-next-line no-console
        console.warn(`${formattedMessage}${metaString}`)
      } else if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.log(`${formattedMessage}${metaString}`)
      }
    } catch {
      // Never let logging break the application (Edge runtime).
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