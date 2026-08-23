/**
 * Failure and wait policy for the unified content worker.
 *
 * Keep this module free of AWS/DB clients so the retry contract can be tested
 * without importing the Lambda handler (whose clients are created at module load).
 */

import { RepositoryPublicationContentionError } from "../../../lib/repositories/content-platform/publication-contention";

export type DeferredProcessingReason =
  | "CONTENT_PLATFORM_DISABLED"
  | "AWAITING_SECURITY_SCAN"
  | "AWAITING_OCR"
  | "AWAITING_MEDIA_ANALYSIS";

export interface DeferredProcessingMetrics {
  waitReason?: DeferredProcessingReason;
  waitStartedAt?: string;
  waitDeadlineExceededAt?: string;
}
export interface ProcessingFailureDecision {
  terminal: boolean;
  code: string;
  message: string;
  refundAttempt?: boolean;
  resetManagedService?: "textract" | "bedrock-data-automation";
}

const DEFER_DEADLINE_MS: Readonly<Record<DeferredProcessingReason, number>> = {
  CONTENT_PLATFORM_DISABLED: 24 * 60 * 60 * 1_000,
  AWAITING_SECURITY_SCAN: 2 * 60 * 60 * 1_000,
  AWAITING_OCR: 60 * 60 * 1_000,
  AWAITING_MEDIA_ANALYSIS: 6 * 60 * 60 * 1_000,
};

/**
 * Re-poll cadence per wait reason: `initial` is the first delay, doubling for
 * each further minute already spent on this reason, bounded by `cap`.
 *
 * These waits were previously one flat 60s for every reason. That was wildly
 * mismatched to what is actually being waited on: GuardDuty tags a small object
 * within seconds and Textract returns a single image in seconds, yet each cost a
 * full minute. In prod a Nexus image paid 60s for the malware tag plus another
 * 60s for OCR — 120s of pure sleep around ~2s of real work, per file.
 *
 * Backing off with elapsed wait keeps the common case (service answers almost
 * immediately) fast without polling a genuinely slow job hundreds of times.
 */
const DEFER_BACKOFF: Readonly<
  Record<DeferredProcessingReason, { initialSeconds: number; capSeconds: number }>
> = {
  // Nothing changes until an operator re-enables the platform — poll rarely.
  CONTENT_PLATFORM_DISABLED: { initialSeconds: 300, capSeconds: 900 },
  // GuardDuty usually tags a small upload within a few seconds.
  AWAITING_SECURITY_SCAN: { initialSeconds: 5, capSeconds: 60 },
  // Textract returns a page or an image quickly; multi-page PDFs take longer.
  AWAITING_OCR: { initialSeconds: 5, capSeconds: 60 },
  // Bedrock Data Automation is a minutes-scale job — no value in fast polling.
  AWAITING_MEDIA_ANALYSIS: { initialSeconds: 15, capSeconds: 120 },
};

/** SQS caps DelaySeconds at 15 minutes. */
const MAX_SQS_DELAY_SECONDS = 900;

/**
 * How long to wait before re-checking a deferred job, given how long this wait
 * has already been running. Pure and total so the cadence can be asserted in
 * tests without SQS or a clock.
 */
export function deferDelaySeconds(
  reason: DeferredProcessingReason,
  elapsedWaitMs = 0
): number {
  const { initialSeconds, capSeconds } = DEFER_BACKOFF[reason];
  const elapsed = Number.isFinite(elapsedWaitMs) ? Math.max(0, elapsedWaitMs) : 0;
  // Bounded exponent: 2**10 already exceeds every cap, and it keeps the result
  // finite if a corrupt waitStartedAt ever yields an enormous elapsed value.
  const doublings = Math.min(10, Math.floor(elapsed / 60_000));
  const delay = initialSeconds * 2 ** doublings;
  return Math.max(1, Math.min(capSeconds, MAX_SQS_DELAY_SECONDS, Math.round(delay)));
}

/**
 * Milliseconds already spent on the CURRENT wait reason. A reason change resets
 * the clock (scan -> OCR), matching prepareDeferredProcessingMetrics.
 */
export function elapsedWaitMs(
  metrics: DeferredProcessingMetrics,
  reason: DeferredProcessingReason,
  now = new Date()
): number {
  if (metrics.waitReason !== reason || !metrics.waitStartedAt) {
    return 0;
  }
  const startedAt = Date.parse(metrics.waitStartedAt);
  if (!Number.isFinite(startedAt)) {
    return 0;
  }
  return Math.max(0, now.getTime() - startedAt);
}

const RETRYABLE_AWS_ERROR =
  /(?:throttl|timeout|timedout|requesttimeout|serviceunavailable|internalserver|slowdown|temporar|network|connection)/i;

const PERMANENT_MESSAGE =
  /(?:outside (?:its|the) .*namespace|unsupported content type|has no S3 object key|has no declared content type|exceeds the configured|OCR is disabled|superseded item version|requires a clean malware inspection|segments? (?:cannot be empty|must have)|requires a page citation|must be stored as an artifact object|did not match|does not match the item version|Invalid binary character|set of allowed characters is|(?:do|does) not match the replay|canonical artifact has no bound payload)/i;

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
 * A managed asynchronous provider accepted the request but finished its job in
 * a failed state. Retrying the same provider id/client token can only replay
 * that failure, so the durable retry must clear provider state and start a new
 * processing run with a fresh idempotency token.
 */
export class RetryableManagedServiceJobError extends Error {
  readonly code: string;
  readonly provider: "textract" | "bedrock-data-automation";

  constructor(
    provider: "textract" | "bedrock-data-automation",
    code: string,
    message: string
  ) {
    super(message);
    this.name = "RetryableManagedServiceJobError";
    this.provider = provider;
    this.code = normalizedErrorCode(code, "MANAGED_SERVICE_JOB_FAILED");
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
  if (error instanceof RepositoryPublicationContentionError) {
    return {
      terminal: false,
      code: "REPOSITORY_PUBLICATION_CONTENTION",
      message,
      refundAttempt: true,
    };
  }
  if (error instanceof PermanentContentProcessingError) {
    return { terminal: true, code: error.code, message };
  }
  if (error instanceof RetryableManagedServiceJobError) {
    return {
      terminal: false,
      code: error.code,
      message,
      resetManagedService: error.provider,
    };
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
 * Start or continue one managed-service wait. Most waits fail after their
 * service-specific deadline. BDA is different: it has no cancellation API and
 * may still be writing S3 output, so an overdue invocation enters an observable
 * reconciliation state and remains pollable until AWS reports it terminal.
 * Changing wait reasons starts a new clock (for example scan -> OCR).
 */
export function prepareDeferredProcessingMetrics<T extends DeferredProcessingMetrics>(
  metrics: T,
  reason: DeferredProcessingReason,
  now = new Date()
): T & {
  waitReason: DeferredProcessingReason;
  waitStartedAt: string;
  waitDeadlineExceededAt?: string;
} {
  const existingStartedAt =
    metrics.waitReason === reason && metrics.waitStartedAt
      ? Date.parse(metrics.waitStartedAt)
      : Number.NaN;
  const startedAt = Number.isFinite(existingStartedAt)
    ? existingStartedAt
    : now.getTime();
  const deadlineMs = DEFER_DEADLINE_MS[reason];
  if (now.getTime() - startedAt >= deadlineMs) {
    if (reason === "AWAITING_MEDIA_ANALYSIS") {
      return {
        ...metrics,
        waitReason: reason,
        waitStartedAt: new Date(startedAt).toISOString(),
        waitDeadlineExceededAt:
          metrics.waitReason === reason && metrics.waitDeadlineExceededAt
            ? metrics.waitDeadlineExceededAt
            : now.toISOString(),
      };
    }
    throw new PermanentContentProcessingError(
      `${reason}_TIMEOUT`,
      `Content processing timed out while ${reason.toLowerCase().replaceAll("_", " ")}`
    );
  }
  const {
    waitDeadlineExceededAt: _waitDeadlineExceededAt,
    ...remainingMetrics
  } = metrics;
  return {
    ...remainingMetrics,
    waitReason: reason,
    waitStartedAt: new Date(startedAt).toISOString(),
  } as T & {
    waitReason: DeferredProcessingReason;
    waitStartedAt: string;
    waitDeadlineExceededAt?: string;
  };
}
