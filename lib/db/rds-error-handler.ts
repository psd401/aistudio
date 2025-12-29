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
 * Check if an error is retryable based on AWS error codes
 */
export function isRetryableError(error: unknown): boolean {
  // Guard against null and undefined
  if (error == null) {
    return false
  }

  // Check for specific retryable AWS errors
  const retryableErrorNames = [
    'InternalServerErrorException',
    'ServiceUnavailableException',
    'ThrottlingException',
    'TooManyRequestsException',
    'RequestTimeoutException',
    'UnknownError'
  ]

  const retryableErrorCodes = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EPIPE',
    'ENOTFOUND'
  ]

  const retryableStatusCodes = [500, 502, 503, 504, 429]

  // Check error name
  if (isErrorWithName(error) && retryableErrorNames.includes(error.name)) {
    return true
  }

  // Check error code
  if (isErrorWithCode(error) && retryableErrorCodes.includes(error.code)) {
    return true
  }

  // Check HTTP status code
  if (isErrorWithMetadata(error) && retryableStatusCodes.includes(error.$metadata.httpStatusCode)) {
    return true
  }

  // Check for network-related error messages
  if (isErrorWithMessage(error)) {
    const networkErrorPatterns = [
      /network/i,
      /timeout/i,
      /connection/i,
      /econnreset/i,
      /socket hang up/i
    ]

    if (networkErrorPatterns.some(pattern => pattern.test(error.message))) {
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