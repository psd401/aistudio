/**
 * Failure and wait policy for the unified content worker.
 *
 * Keep this module free of AWS/DB clients so the retry contract can be tested
 * without importing the Lambda handler (whose clients are created at module load).
 */

export type DeferredProcessingReason =
  | "CONTENT_PLATFORM_DISABLED"
  | "AWAITING_SECURITY_SCAN"
  | "AWAITING_OCR"
  | "AWAITING_MEDIA_ANALYSIS";

export interface DeferredProcessingMetrics {
  waitReason?: DeferredProcessingReason;
  waitStartedAt?: string;
}
export interface ProcessingFailureDecision {
  terminal: boolean;
  code: string;
  message: string;
}

const DEFER_DEADLINE_MS: Readonly<Record<DeferredProcessingReason, number>> = {
  CONTENT_PLATFORM_DISABLED: 24 * 60 * 60 * 1_000,
  AWAITING_SECURITY_SCAN: 2 * 60 * 60 * 1_000,
  AWAITING_OCR: 60 * 60 * 1_000,
  AWAITING_MEDIA_ANALYSIS: 6 * 60 * 60 * 1_000,
};

const RETRYABLE_AWS_ERROR =
  /(?:throttl|timeout|timedout|requesttimeout|serviceunavailable|internalserver|slowdown|temporar|network|connection)/i;

const PERMANENT_MESSAGE =
  /(?:outside (?:its|the) .*namespace|unsupported content type|has no S3 object key|has no declared content type|exceeds the configured|OCR is disabled|superseded item version|requires a clean malware inspection|segments? (?:cannot be empty|must have)|requires a page citation|must be stored as an artifact object|did not match|does not match the item version)/i;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

function normalizedErrorCode(value: string, fallback: string): string {
  const code = value
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 128);
  return code || fallback;
}

function awsHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return null;
  }
  const metadata = error.$metadata;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("httpStatusCode" in metadata) ||
    typeof metadata.httpStatusCode !== "number"
  ) {
    return null;
  }
  return metadata.httpStatusCode;
}

export class PermanentContentProcessingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PermanentContentProcessingError";
    this.code = normalizedErrorCode(code, "PERMANENT_PROCESSING_ERROR");
  }
}

/**
 * Treat deterministic source/contract failures and non-retryable AWS 4xx errors
 * as terminal. Unknown infrastructure/database failures retain the bounded retry
 * budget because they are commonly transient.
 */
export function classifyContentProcessingError(
  error: unknown
): ProcessingFailureDecision {
  const message = errorMessage(error);
  if (error instanceof PermanentContentProcessingError) {
    return { terminal: true, code: error.code, message };
  }

  const name = error instanceof Error ? error.name : "";
  if (RETRYABLE_AWS_ERROR.test(name) || RETRYABLE_AWS_ERROR.test(message)) {
    return { terminal: false, code: "TRANSIENT_PROCESSING_ERROR", message };
  }

  const httpStatus = awsHttpStatus(error);
  if (httpStatus != null && httpStatus >= 400 && httpStatus < 500) {
    return {
      terminal: true,
      code: normalizedErrorCode(name, "UPSTREAM_CLIENT_ERROR"),
      message,
    };
  }
  if (PERMANENT_MESSAGE.test(message)) {
    return { terminal: true, code: "INVALID_SOURCE_CONTENT", message };
  }
  return { terminal: false, code: "TRANSIENT_PROCESSING_ERROR", message };
}

/** Five-second exponential retry, jittered and bounded by SQS's 15-minute delay. */
export function processingRetryDelaySeconds(
  attempt: number,
  random: () => number = Math.random
): number {
  const safeAttempt = Math.max(1, Math.min(20, Math.floor(attempt)));
  const base = Math.min(900, 5 * 2 ** (safeAttempt - 1));
  const jitter = 0.75 + Math.min(1, Math.max(0, random())) * 0.5;
  return Math.max(1, Math.min(900, Math.round(base * jitter)));
}

/**
 * Start or continue one managed-service wait and fail it after a service-specific
 * deadline. Changing wait reasons starts a new clock (for example scan -> OCR).
 */
export function prepareDeferredProcessingMetrics<T extends DeferredProcessingMetrics>(
  metrics: T,
  reason: DeferredProcessingReason,
  now = new Date()
): T & Required<DeferredProcessingMetrics> {
  const existingStartedAt =
    metrics.waitReason === reason && metrics.waitStartedAt
      ? Date.parse(metrics.waitStartedAt)
      : Number.NaN;
  const startedAt = Number.isFinite(existingStartedAt)
    ? existingStartedAt
    : now.getTime();
  const deadlineMs = DEFER_DEADLINE_MS[reason];
  if (now.getTime() - startedAt >= deadlineMs) {
    throw new PermanentContentProcessingError(
      `${reason}_TIMEOUT`,
      `Content processing timed out while ${reason.toLowerCase().replaceAll("_", " ")}`
    );
  }
  return {
    ...metrics,
    waitReason: reason,
    waitStartedAt: new Date(startedAt).toISOString(),
  };
}
