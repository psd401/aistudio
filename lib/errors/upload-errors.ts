/**
 * Typed error for upload pipeline failures. Throw this instead of plain Error
 * to bypass string-based pattern matching and ensure correct classification.
 *
 * This avoids implicit coupling between error message text and the
 * ERROR_PATTERNS array in the upload route's classifyUploadError().
 */
export class UploadClassifiedError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly statusCode: number,
    cause?: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause ?? userMessage));
    this.name = 'UploadClassifiedError';
  }
}
