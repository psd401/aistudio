/**
 * Atrium content service error types
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). See docs/features/atrium-design-spec.md §29.
 *
 * These are the domain errors the content services throw. They carry a stable
 * `code` and an HTTP `status` so each surface can map them uniformly:
 * - Server actions wrap them with `handleError(...)` -> `ActionState`.
 * - REST/MCP handlers map `status` to a response status and `code` to a body.
 *
 * They extend the repo's `createError` pattern (a typed Error with `code` and
 * `level`) so existing logging/serialization treats them consistently.
 */

import { ErrorLevel } from "@/types/actions-types";

/** Base class for Atrium content errors, carrying an HTTP status for surfaces. */
export class ContentError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  /**
   * Log level. Present so the repo's `handleError` (which routes any Error with
   * a `code` through its TypedError branch and switches on `level`) actually
   * logs these errors. Without it the switch would fall through and the error
   * would be silently dropped from the logs. 5xx -> ERROR, everything else
   * (client/validation/approval) -> WARN.
   */
  readonly level: ErrorLevel;

  constructor(
    message: string,
    code: string,
    status: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
    this.level = status >= 500 ? ErrorLevel.ERROR : ErrorLevel.WARN;
    // Maintain a proper prototype chain when targeting ES5-ish output.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 403 — the requester may not perform this action / view this object. */
export class ForbiddenError extends ContentError {
  constructor(message = "Forbidden", details?: Record<string, unknown>) {
    super(message, "CONTENT_FORBIDDEN", 403, details);
  }
}

/** 404 — the object (or related row) does not exist. */
export class NotFoundError extends ContentError {
  constructor(message = "Not found", details?: Record<string, unknown>) {
    super(message, "CONTENT_NOT_FOUND", 404, details);
  }
}

/** 400 — the input failed validation. */
export class ValidationError extends ContentError {
  constructor(message = "Invalid input", details?: Record<string, unknown>) {
    super(message, "CONTENT_VALIDATION", 400, details);
  }
}

/** 409 — a uniqueness/version race (slug collision, version-number conflict). */
export class ConflictError extends ContentError {
  constructor(message = "Conflict", details?: Record<string, unknown>) {
    super(message, "CONTENT_CONFLICT", 409, details);
  }
}

/** 503 — canonical content storage is temporarily unavailable or corrupt. */
export class StorageError extends ContentError {
  constructor(
    message = "Content source is temporarily unavailable",
    details?: Record<string, unknown>
  ) {
    super(message, "CONTENT_STORAGE_ERROR", 503, details);
  }
}

/**
 * 409 — a public-facing publish was requested by a caller that lacks
 * `content:publish_public`; the request enters the approval queue rather than
 * publishing. Defined here for the service contract; the publish service that
 * throws it lands in Phase 5/7.
 *
 * Status is `409 Conflict` (an error code), NOT `202 Accepted`. `202` is an
 * HTTP *success* code: a surface that maps `error.status` directly to the
 * response would emit `202` on a thrown exception, which is contradictory, and
 * clients expecting a `4xx` for "not permitted yet" would not recognise it.
 * When the Phase 5/7 publish service *returns* an approval response normally
 * (not by throwing), it may use `202` on that success path — but the thrown
 * error here is a workflow gate (handled by `handleError` at WARN level via the
 * `< 500` branch) and must carry a client-error status.
 */
export class ApprovalRequiredError extends ContentError {
  constructor(
    message = "Approval required",
    details?: Record<string, unknown>
  ) {
    super(message, "CONTENT_APPROVAL_REQUIRED", 409, details);
  }
}

/** Type guard for the Atrium content error family. */
export function isContentError(error: unknown): error is ContentError {
  return error instanceof ContentError;
}
