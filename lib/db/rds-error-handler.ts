import { createLogger, generateRequestId, startTimer } from "@/lib/logger"

interface CircuitBreakerState {
  failureCount: number
  lastFailureTime: number
  state: "closed" | "open" | "half-open"
  successCount: number
}

interface RetryOptions {
  maxRetries?: number
  initialDelay?: number
  maxDelay?: number
  backoffMultiplier?: number
  jitterMax?: number
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelay: 100,
  maxDelay: 5000,
  backoffMultiplier: 2,
  jitterMax: 100
}

// Circuit breaker configuration
const CIRCUIT_BREAKER_THRESHOLD = 5 // Number of failures before opening circuit
const CIRCUIT_BREAKER_TIMEOUT = 30000 // 30 seconds before attempting to close
const CIRCUIT_BREAKER_SUCCESS_THRESHOLD = 2 // Successes needed to close circuit

// Global circuit breaker state
const circuitBreakerState: CircuitBreakerState = {
  failureCount: 0,
  lastFailureTime: 0,
  state: "closed",
  successCount: 0
}

// Type guards for runtime type safety
function isErrorWithName(error: unknown): error is { name: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
  )
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  )
}

function isErrorWithMetadata(
  error: unknown
): error is { $metadata: { httpStatusCode: number } } {
  return (
    typeof error === 'object' &&
    error !== null &&
    '$metadata' in error &&
    typeof error.$metadata === 'object' &&
    error.$metadata !== null &&
    'httpStatusCode' in error.$metadata &&
    typeof error.$metadata.httpStatusCode === 'number'
  )
}

function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  )
}

/**
 * Check if an error is retryable based on error codes
 *
 * Supports both AWS errors and postgres.js/PostgreSQL errors.
 * Issue #603 added postgres.js error code support.
 */
export function isRetryableError(error: unknown): boolean {
  // Guard against null and undefined
  if (error == null) {
    return false
  }

  // Retryable error names (AWS SDK and postgres.js)
  const retryableErrorNames = [
    'InternalServerErrorException',
    'ServiceUnavailableException',
    'ThrottlingException',
    'TooManyRequestsException',
    'RequestTimeoutException',
    'UnknownError',
    // postgres.js specific
    'PostgresError',
    'ConnectionError',
  ]

  // Retryable error codes (Node.js and PostgreSQL)
  const retryableErrorCodes = [
    // Node.js network errors
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EPIPE',
    'ENOTFOUND',
    // PostgreSQL error codes (Class 08 - Connection Exception)
    '08000', // connection_exception
    '08003', // connection_does_not_exist
    '08006', // connection_failure
    '08001', // sqlclient_unable_to_establish_sqlconnection
    '08004', // sqlserver_rejected_establishment_of_sqlconnection
    '08007', // transaction_resolution_unknown
    '08P01', // protocol_violation
    // PostgreSQL error codes (Class 53 - Insufficient Resources)
    '53000', // insufficient_resources
    '53100', // disk_full
    '53200', // out_of_memory
    '53300', // too_many_connections
    // PostgreSQL error codes (Class 57 - Operator Intervention)
    '57000', // operator_intervention
    '57014', // query_canceled
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now
  ]

  const retryableStatusCodes = [500, 502, 503, 504, 429]

  // Check error name
  if (isErrorWithName(error) && retryableErrorNames.includes(error.name)) {
    return true
  }

  // Check error code (string codes like ECONNRESET and PostgreSQL codes)
  if (isErrorWithCode(error) && retryableErrorCodes.includes(error.code)) {
    return true
  }

  // Check HTTP status code (AWS SDK errors)
  if (isErrorWithMetadata(error) && retryableStatusCodes.includes(error.$metadata.httpStatusCode)) {
    return true
  }

  // Check for connection-related error messages
  if (isErrorWithMessage(error)) {
    const connectionErrorPatterns = [
      /network/i,
      /timeout/i,
      /connection/i,
      /econnreset/i,
      /socket hang up/i,
      // postgres.js specific patterns
      /terminating connection/i,
      /server closed the connection/i,
      /too many connections/i,
      /Connection terminated/i,
      /Connection refused/i,
      /Connection reset/i,
    ]

    if (connectionErrorPatterns.some(pattern => pattern.test(error.message))) {
      return true
    }
  }

  return false
}

/**
 * Calculate delay with exponential backoff and jitter
 */
export function calculateDelay(
  attempt: number, 
  options: Required<RetryOptions>
): number {
  const exponentialDelay = Math.min(
    options.initialDelay * Math.pow(options.backoffMultiplier, attempt - 1),
    options.maxDelay
  )
  
  // Add random jitter to prevent thundering herd
  const jitter = Math.random() * options.jitterMax
  
  return exponentialDelay + jitter
}

/**
 * Check if circuit breaker should allow request
 */
export function checkCircuitBreaker(): boolean {
  const now = Date.now()
  
  switch (circuitBreakerState.state) {
    case "open":
      // Check if enough time has passed to try again
      if (now - circuitBreakerState.lastFailureTime > CIRCUIT_BREAKER_TIMEOUT) {
        circuitBreakerState.state = "half-open"
        circuitBreakerState.successCount = 0
        return true
      }
      return false
      
    case "half-open":
      // Allow request but monitor closely
      return true
      
    case "closed":
    default:
      return true
  }
}

/**
 * Record success in circuit breaker
 */
export function recordSuccess(): void {
  if (circuitBreakerState.state === "half-open") {
    circuitBreakerState.successCount++
    
    if (circuitBreakerState.successCount >= CIRCUIT_BREAKER_SUCCESS_THRESHOLD) {
      // Circuit can be fully closed
      circuitBreakerState.state = "closed"
      circuitBreakerState.failureCount = 0
      circuitBreakerState.successCount = 0
    }
  } else if (circuitBreakerState.state === "closed") {
    // Reset failure count on success
    circuitBreakerState.failureCount = 0
  }
}

/**
 * Record failure in circuit breaker
 */
export function recordFailure(): void {
  circuitBreakerState.failureCount++
  circuitBreakerState.lastFailureTime = Date.now()
  
  if (circuitBreakerState.state === "half-open") {
    // Immediately open circuit on failure in half-open state
    circuitBreakerState.state = "open"
  } else if (circuitBreakerState.failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
    // Open circuit after threshold reached
    circuitBreakerState.state = "open"
  }
}

/**
 * Execute a function with retry logic and circuit breaker
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  context: string,
  options?: RetryOptions,
  requestId?: string
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options }
  const reqId = requestId || generateRequestId()
  const timer = startTimer(`executeWithRetry_${context}`)
  const log = createLogger({ 
    requestId: reqId,
    context, 
    operation: "executeWithRetry" 
  })
  
  // Check circuit breaker first
  if (!checkCircuitBreaker()) {
    log.warn("Circuit breaker is open", {
      state: circuitBreakerState.state,
      failureCount: circuitBreakerState.failureCount
    })
    timer({ status: "circuit_open" })
    throw new Error("Circuit breaker is open - service temporarily unavailable")
  }
  
  let lastError: Error | null = null
  
  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      log.debug("Attempting operation", { 
        attempt, 
        maxRetries: opts.maxRetries,
        context 
      })
      
      const result = await fn()
      
      // Record success
      recordSuccess()
      
      if (attempt > 1) {
        log.info("Retry successful", { 
          attempt, 
          context,
          totalDuration: timer({ status: "success_with_retry" })
        })
      } else {
        timer({ status: "success" })
      }
      
      return result
    } catch (error) {
      lastError = error as Error
      
      // Check if error is retryable
      if (!isRetryableError(error)) {
        log.error("Non-retryable error encountered", { 
          error: lastError.message,
          errorName: (error as { name?: string }).name,
          context,
          attempt,
          requestId: reqId
        })
        timer({ status: "non_retryable_error" })
        throw error
      }
      
      // Record failure
      recordFailure()
      
      // Check if we should retry
      if (attempt < opts.maxRetries) {
        const delay = calculateDelay(attempt, opts)
        
        log.warn("Retryable error encountered, will retry", {
          error: lastError.message,
          errorName: (error as { name?: string }).name,
          context,
          attempt,
          maxRetries: opts.maxRetries,
          delayMs: delay,
          circuitState: circuitBreakerState.state,
          requestId: reqId
        })
        
        await new Promise(resolve => setTimeout(resolve, delay))
      } else {
        log.error("Max retries exceeded", {
          error: lastError.message,
          errorName: (error as { name?: string }).name,
          context,
          attempts: attempt,
          circuitState: circuitBreakerState.state,
          totalDuration: timer({ status: "max_retries_exceeded" }),
          requestId: reqId
        })
      }
    }
  }
  
  // All retries exhausted
  throw lastError || new Error(`Operation failed after ${opts.maxRetries} attempts`)
}

/**
 * Get current circuit breaker state (for monitoring)
 */
export function getCircuitBreakerState(): Readonly<CircuitBreakerState> {
  return { ...circuitBreakerState }
}

/**
 * Reset circuit breaker (for testing or manual intervention)
 */
export function resetCircuitBreaker(): void {
  circuitBreakerState.failureCount = 0
  circuitBreakerState.lastFailureTime = 0
  circuitBreakerState.state = "closed"
  circuitBreakerState.successCount = 0
}