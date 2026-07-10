/**
 * Standard response type for all server actions and API endpoints
 * Provides a consistent interface for handling success and error states
 */
export type ActionState<T = unknown> =
  | { isSuccess: true; message: string; data: T }
  | {
      isSuccess: false
      message: string
      error?: Error | unknown
      data?: never
      /**
       * Optional: the action did not fail so much as require approval (e.g. the
       * Atrium §26.4 public-publish gate). Callers that set it let a surface
       * distinguish a pending-approval outcome from a real error, mirroring how
       * the REST/MCP surfaces map `ApprovalRequiredError` to a 202/`approval_required`.
       */
      approvalRequired?: boolean
    }

/**
 * Error levels for logging
 */
export enum ErrorLevel {
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal'
}

/**
 * Structured error object for consistent error handling
 */
export interface AppError extends Error {
  code?: string;
  level: ErrorLevel;
  details?: Record<string, unknown>;
}