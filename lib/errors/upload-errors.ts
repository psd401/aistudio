/**
 * Known upload error codes. Used by UploadClassifiedError, ERROR_PATTERNS
 * in the upload route, and CODE_TO_SAFE_MESSAGE in the attachment adapter.
 */
export type UploadErrorCode =
  | 'STORAGE_UNAVAILABLE'
  | 'UPLOAD_TIMEOUT'
  | 'INVALID_FORMAT'
  | 'FILE_TOO_LARGE'
  | 'JOB_SERVICE_UNAVAILABLE'
  | 'QUEUE_UNAVAILABLE'
  | 'CONFIG_ERROR'
  | 'UPLOAD_FAILED'
  | 'NO_FILE'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED';

/**
 * Typed error for upload pipeline failures. Throw this instead of plain Error
 * to bypass string-based pattern matching and ensure correct classification.
 *
 * This avoids implicit coupling between error message text and the
 * ERROR_PATTERNS array in the upload route's classifyUploadError().
 */
export class UploadClassifiedError extends Error {
  constructor(
    public readonly code: UploadErrorCode,
    public readonly userMessage: string,
    public readonly statusCode: number,
    cause?: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause ?? userMessage), cause != null ? { cause } : undefined);
    this.name = 'UploadClassifiedError';
  }
}
