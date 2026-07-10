/**
 * Lambda-compatible structured logger
 * Provides structured logging for AWS Lambda functions with CloudWatch integration
 */

export interface LogContext {
  requestId?: string;
  jobId?: string;
  service?: string;
  operation?: string;
  processorType?: string;
  [key: string]: any;
}

export interface LogMetrics {
  processingTime?: number;
  fileSize?: number;
  status?: string;
  [key: string]: any;
}

export class LambdaLogger {
  private context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = {
      service: 'document-processor-v2',
      timestamp: new Date().toISOString(),
      ...context
    };
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const logEntry = {
      level: level.toUpperCase(),
      message,
      ...this.context,
      ...(data && { data: this.sanitizeData(data) }),
      timestamp: new Date().toISOString()
    };

    return JSON.stringify(logEntry);
  }

  private sanitizeData(data: any): any {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data === 'string') {
      // Redact secret VALUES, not the keyword names (REV-INFRA-095). The old regex
      // replaced the literal words password/secret/key/token/auth wherever they
      // appeared, so `Authorization: Bearer abc123` became `[REDACTED]orization:
      // Bearer abc123` — masking a harmless word while leaking the token in full.
      // This redacts the value after a sensitive key (`key=VALUE`, `key: VALUE`,
      // `Authorization: Bearer VALUE`), including quoted forms common in serialized
      // JSON/XML (`"token": "supersecret"`, `token="supersecret"`) (REV-INFRA-096) —
      // the unquoted-only version missed these entirely. Free-form message strings
      // are otherwise NOT deep-scrubbed — callers must avoid interpolating secrets
      // into messages.
      return data.replace(
        /(["']?)\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|auth[_-]?token)\b\1(\s*[:=]\s*)(["']?)((?:bearer\s+)?)([^\s"',;})&]+)\4/gi,
        '$1$2$1$3$4$5[REDACTED]$4'
      );
    }

    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeData(item));
    }

    if (typeof data === 'object') {
      // Object.create(null) so a document-controlled `__proto__`/`constructor` key
      // cannot pollute Object.prototype via `sanitized[key] = ...` (REV-INFRA-095).
      const sanitized: Record<string, unknown> = Object.create(null);
      for (const [key, value] of Object.entries(data)) {
        const lower = key.toLowerCase();
        // Redact when the KEY names a secret. Word-ish matches (not a bare `key`
        // substring) so benign keys like s3Key / chunkKey / publicKey are not
        // over-redacted, while `auth` is included for parity with the string branch.
        const isSensitive =
          LambdaLogger.SENSITIVE_KEY_RE.test(lower) || lower === 'key' || lower === 'auth';
        if (isSensitive) {
          sanitized[key] = '[REDACTED]';
        } else {
          sanitized[key] = this.sanitizeData(value);
        }
      }
      return sanitized;
    }

    return data;
  }

  private static readonly SENSITIVE_KEY_RE =
    /password|passwd|secret|token|credential|api[_-]?key|access[_-]?key|authorization|auth[_-]?token/i;

  info(message: string, data?: any): void {
    // In Lambda, console.log goes to CloudWatch automatically
    // eslint-disable-next-line no-console
    console.log(this.formatMessage('info', message, data));
  }

  error(message: string, error?: Error | any, data?: any): void {
    const errorData = error instanceof Error ? {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
      ...data
    } : { error, ...data };

    // eslint-disable-next-line no-console
    console.error(this.formatMessage('error', message, errorData));
  }

  warn(message: string, data?: any): void {
    // eslint-disable-next-line no-console
    console.warn(this.formatMessage('warn', message, data));
  }

  debug(message: string, data?: any): void {
    // Only log debug messages if DEBUG environment variable is set
    if (process.env.DEBUG) {
      // eslint-disable-next-line no-console
      console.debug(this.formatMessage('debug', message, data));
    }
  }

  withContext(additionalContext: LogContext): LambdaLogger {
    return new LambdaLogger({
      ...this.context,
      ...additionalContext
    });
  }

  startTimer(operation: string): () => void {
    const startTime = Date.now();
    return () => {
      const duration = Date.now() - startTime;
      this.info(`Operation completed: ${operation}`, {
        operation,
        duration,
        metrics: { processingTime: duration }
      });
    };
  }

  logMetrics(operation: string, metrics: LogMetrics): void {
    this.info(`Metrics: ${operation}`, {
      operation,
      metrics
    });
  }
}

/**
 * Create a logger instance with optional context
 */
export function createLambdaLogger(context?: LogContext): LambdaLogger {
  return new LambdaLogger(context);
}

/**
 * Default logger instance for simple use cases
 */
export const defaultLogger = new LambdaLogger();