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
  [key: string]: unknown;
}

export interface LogMetrics {
  processingTime?: number;
  fileSize?: number;
  status?: string;
  [key: string]: unknown;
}

const SENSITIVE_ASSIGNMENT_KEYS = [
  'authorization',
  'access_token',
  'access-token',
  'accesstoken',
  'auth_token',
  'auth-token',
  'authtoken',
  'password',
  'passwd',
  'api_key',
  'api-key',
  'apikey',
  'secret',
  'token',
] as const;

interface SensitiveKeyMatch {
  index: number;
  key: string;
}

function isWordCharacter(character: string | undefined): boolean {
  if (!character) return false;
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    character === '_'
  );
}

function findSensitiveKey(
  lower: string,
  fromIndex: number
): SensitiveKeyMatch | null {
  let earliest: SensitiveKeyMatch | null = null;
  for (const key of SENSITIVE_ASSIGNMENT_KEYS) {
    let index = lower.indexOf(key, fromIndex);
    while (index !== -1) {
      const before = lower[index - 1];
      const after = lower[index + key.length];
      if (!isWordCharacter(before) && !isWordCharacter(after)) {
        if (!earliest || index < earliest.index) {
          earliest = { index, key };
        }
        break;
      }
      index = lower.indexOf(key, index + key.length);
    }
  }
  return earliest;
}

function skipWhitespace(input: string, start: number): number {
  let index = start;
  while (index < input.length && /\s/.test(input[index])) index += 1;
  return index;
}

function findSecretValueSpan(
  input: string,
  lower: string,
  match: SensitiveKeyMatch
): { start: number; end: number } | null {
  let index = match.index + match.key.length;
  const keyQuote = input[match.index - 1];
  if ((keyQuote === '"' || keyQuote === "'") && input[index] === keyQuote) {
    index += 1;
  }
  index = skipWhitespace(input, index);
  if (input[index] !== ':' && input[index] !== '=') return null;
  index = skipWhitespace(input, index + 1);
  if (input[index] === '"' || input[index] === "'") index += 1;

  if (lower.startsWith('bearer', index) && /\s/.test(input[index + 6] ?? '')) {
    index = skipWhitespace(input, index + 6);
  }

  const start = index;
  const valueDelimiters = new Set(['"', "'", ',', ';', '}', ')', '&']);
  while (
    index < input.length &&
    !/\s/.test(input[index]) &&
    !valueDelimiters.has(input[index])
  ) {
    index += 1;
  }
  return index > start ? { start, end: index } : null;
}

function redactSensitiveAssignments(input: string): string {
  const lower = input.toLowerCase();
  let cursor = 0;
  let searchIndex = 0;
  let output = '';

  while (searchIndex < input.length) {
    const match = findSensitiveKey(lower, searchIndex);
    if (!match) break;
    const span = findSecretValueSpan(input, lower, match);
    if (!span) {
      searchIndex = match.index + match.key.length;
      continue;
    }
    output += `${input.slice(cursor, span.start)}[REDACTED]`;
    cursor = span.end;
    searchIndex = span.end;
  }

  return output + input.slice(cursor);
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

  private formatMessage(level: string, message: string, data?: unknown): string {
    const logEntry = {
      level: level.toUpperCase(),
      message,
      ...this.context,
      ...(data && { data: this.sanitizeData(data) }),
      timestamp: new Date().toISOString()
    };

    return JSON.stringify(logEntry);
  }

  private sanitizeData(data: unknown): unknown {
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
      return redactSensitiveAssignments(data);
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

  info(message: string, data?: unknown): void {
    // In Lambda, console.log goes to CloudWatch automatically

    console.log(this.formatMessage('info', message, data));
  }

  error(message: string, error?: Error | unknown, data?: unknown): void {
    const errorData = error instanceof Error ? {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
      ...data
    } : { error, ...data };


    console.error(this.formatMessage('error', message, errorData));
  }

  warn(message: string, data?: unknown): void {

    console.warn(this.formatMessage('warn', message, data));
  }

  debug(message: string, data?: unknown): void {
    // Only log debug messages if DEBUG environment variable is set
    if (process.env.DEBUG) {

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
