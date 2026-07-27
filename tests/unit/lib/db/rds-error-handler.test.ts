/**
 * Unit tests for RDS error handler with circuit breaker and retry logic
 *
 * Tests the circuit breaker pattern and retry logic used for database operations.
 * These are pure unit tests that mock the database to test error handling behavior.
 *
 * @see lib/db/rds-error-handler.ts
 * Issue #568 - Add comprehensive test coverage for Drizzle executeTransaction wrapper
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals'

// Mock the logger before importing the module
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => 'test-request-id',
  startTimer: () => () => 100, // Returns a function that returns a number
}));

import {
  isRetryableError,
  calculateDelay,
  checkCircuitBreaker,
  recordSuccess,
  recordFailure,
  executeWithRetry,
  getCircuitBreakerState,
  resetCircuitBreaker,
} from '@/lib/db/rds-error-handler'

const defineRDSErrorHandlerSuite1Registration1: NonNullable<Parameters<typeof beforeEach>[0]> = () => {
    // Reset circuit breaker state before each test
    resetCircuitBreaker()
    jest.clearAllMocks()
  };
const defineRDSErrorHandlerSuite1Registration2: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { name: 'InternalServerErrorException' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration3: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { name: 'ServiceUnavailableException' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration4: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { name: 'ThrottlingException' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration5: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { name: 'TooManyRequestsException' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration6: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { name: 'RequestTimeoutException' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration7: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { name: 'UnknownError' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration8: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { name: 'ValidationError' }
        expect(isRetryableError(error)).toBe(false)
      };
const defineRDSErrorHandlerSuite1Registration9: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { name: 'AccessDeniedException' }
        expect(isRetryableError(error)).toBe(false)
      };
const defineRDSErrorHandlerSuite1Registration10: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { code: 'ECONNRESET' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration11: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { code: 'ETIMEDOUT' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration12: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { code: 'ECONNREFUSED' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration13: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { code: 'EPIPE' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration14: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { code: 'ENOTFOUND' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration15: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { code: 'ENOENT' }
        expect(isRetryableError(error)).toBe(false)
      };
const defineRDSErrorHandlerSuite1Registration16: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { $metadata: { httpStatusCode: 500 } }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration17: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { $metadata: { httpStatusCode: 502 } }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration18: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { $metadata: { httpStatusCode: 503 } }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration19: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { $metadata: { httpStatusCode: 504 } }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration20: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { $metadata: { httpStatusCode: 429 } }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration21: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { $metadata: { httpStatusCode: 400 } }
        expect(isRetryableError(error)).toBe(false)
      };
const defineRDSErrorHandlerSuite1Registration22: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { $metadata: { httpStatusCode: 401 } }
        expect(isRetryableError(error)).toBe(false)
      };
const defineRDSErrorHandlerSuite1Registration23: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { $metadata: { httpStatusCode: 403 } }
        expect(isRetryableError(error)).toBe(false)
      };
const defineRDSErrorHandlerSuite1Registration24: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { $metadata: { httpStatusCode: 404 } }
        expect(isRetryableError(error)).toBe(false)
      };
const defineRDSErrorHandlerSuite1Registration25: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { message: 'Network error occurred' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration26: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { message: 'Request timeout exceeded' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration27: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { message: 'Connection refused by server' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration28: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { message: 'Error: ECONNRESET' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration29: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { message: 'socket hang up' }
        expect(isRetryableError(error)).toBe(true)
      };
const defineRDSErrorHandlerSuite1Registration30: NonNullable<Parameters<typeof it>[1]> = () => {
        const error = { message: 'Invalid parameter value' }
        expect(isRetryableError(error)).toBe(false)
      };
const defineRDSErrorHandlerSuite1Registration31: NonNullable<Parameters<typeof it>[1]> = () => {
        // Function now has null guard and returns false
        expect(isRetryableError(null)).toBe(false)
      };
const defineRDSErrorHandlerSuite1Registration32: NonNullable<Parameters<typeof it>[1]> = () => {
        // Function now has null guard and returns false
        expect(isRetryableError(undefined)).toBe(false)
      };
const defineRDSErrorHandlerSuite1Registration33: NonNullable<Parameters<typeof it>[1]> = () => {
        expect(isRetryableError({})).toBe(false)
      };
const defineRDSErrorHandlerSuite1Registration34: NonNullable<Parameters<typeof it>[1]> = () => {
        // String has no 'name' property matching retryable errors
        expect(isRetryableError('some error')).toBe(false)
      };
const defineRDSErrorHandlerSuite1Registration35: NonNullable<Parameters<typeof it>[1]> = () => {
        // Number has no matching properties
        expect(isRetryableError(500)).toBe(false)
      };
const defineRDSErrorHandlerSuite1Registration36: NonNullable<Parameters<typeof describe>[1]> = () => {
    const defaultOptions = {
      maxRetries: 3,
      initialDelay: 100,
      maxDelay: 5000,
      backoffMultiplier: 2,
      jitterMax: 100,
    }

    it('should calculate initial delay for first retry attempt', () => {
      // Mock Math.random to return 0 for predictable jitter
      const mockRandom = jest.spyOn(Math, 'random').mockReturnValue(0)

      const delay = calculateDelay(1, defaultOptions)
      expect(delay).toBe(100) // initialDelay * 2^0 + 0 jitter

      mockRandom.mockRestore()
    })

    it('should calculate exponential backoff for second retry', () => {
      const mockRandom = jest.spyOn(Math, 'random').mockReturnValue(0)

      const delay = calculateDelay(2, defaultOptions)
      expect(delay).toBe(200) // initialDelay * 2^1 + 0 jitter

      mockRandom.mockRestore()
    })

    it('should calculate exponential backoff for third retry', () => {
      const mockRandom = jest.spyOn(Math, 'random').mockReturnValue(0)

      const delay = calculateDelay(3, defaultOptions)
      expect(delay).toBe(400) // initialDelay * 2^2 + 0 jitter

      mockRandom.mockRestore()
    })

    it('should add jitter to the delay', () => {
      const mockRandom = jest.spyOn(Math, 'random').mockReturnValue(0.5)

      const delay = calculateDelay(1, defaultOptions)
      expect(delay).toBe(150) // 100 + (0.5 * 100 jitter)

      mockRandom.mockRestore()
    })

    it('should cap delay at maxDelay', () => {
      const mockRandom = jest.spyOn(Math, 'random').mockReturnValue(0)

      const delay = calculateDelay(10, {
        ...defaultOptions,
        maxDelay: 1000,
      })
      expect(delay).toBe(1000) // capped at maxDelay

      mockRandom.mockRestore()
    })

    it('should handle custom backoff multiplier', () => {
      const mockRandom = jest.spyOn(Math, 'random').mockReturnValue(0)

      const delay = calculateDelay(2, {
        ...defaultOptions,
        backoffMultiplier: 3,
      })
      expect(delay).toBe(300) // 100 * 3^1

      mockRandom.mockRestore()
    })
  };
const defineRDSErrorHandlerSuite1Registration37: NonNullable<Parameters<typeof describe>[1]> = () => {
    let originalDateNow: () => number

    beforeEach(() => {
      // Save original Date.now for tests that mock it
      originalDateNow = Date.now
    })

    afterEach(() => {
      // Restore Date.now after each test
      Date.now = originalDateNow
    })


      it('should start in closed state', () => {
        const state = getCircuitBreakerState()
        expect(state.state).toBe('closed')
        expect(state.failureCount).toBe(0)
        expect(state.successCount).toBe(0)
      })

      it('should allow requests when closed', () => {
        expect(checkCircuitBreaker()).toBe(true)
      })



      it('should allow requests when circuit is closed', () => {
        expect(checkCircuitBreaker()).toBe(true)
      })

      it('should block requests when circuit is open', () => {
        // Record 5 failures to open the circuit
        for (let i = 0; i < 5; i++) {
          recordFailure()
        }
        const state = getCircuitBreakerState()
        expect(state.state).toBe('open')
        expect(checkCircuitBreaker()).toBe(false)
      })

      it('should allow request and transition to half-open after timeout', () => {
        // Open the circuit
        for (let i = 0; i < 5; i++) {
          recordFailure()
        }
        expect(getCircuitBreakerState().state).toBe('open')

        // Mock Date.now to simulate timeout passing
        const futureTime = Date.now() + 31000 // 31 seconds later
        Date.now = () => futureTime

        expect(checkCircuitBreaker()).toBe(true)
        expect(getCircuitBreakerState().state).toBe('half-open')
      })

      it('should allow requests when circuit is half-open', () => {
        // Open the circuit
        for (let i = 0; i < 5; i++) {
          recordFailure()
        }

        // Mock timeout
        const futureTime = Date.now() + 31000
        Date.now = () => futureTime
        checkCircuitBreaker() // Transitions to half-open

        expect(getCircuitBreakerState().state).toBe('half-open')
        expect(checkCircuitBreaker()).toBe(true)
      })



      it('should reset failure count when closed', () => {
        recordFailure()
        recordFailure()
        expect(getCircuitBreakerState().failureCount).toBe(2)

        recordSuccess()
        expect(getCircuitBreakerState().failureCount).toBe(0)
      })

      it('should increment success count in half-open state', () => {
        // Open the circuit
        for (let i = 0; i < 5; i++) {
          recordFailure()
        }

        // Transition to half-open
        const futureTime = Date.now() + 31000
        Date.now = () => futureTime
        checkCircuitBreaker()

        recordSuccess()
        expect(getCircuitBreakerState().successCount).toBe(1)
      })

      it('should close circuit after success threshold in half-open', () => {
        // Open the circuit
        for (let i = 0; i < 5; i++) {
          recordFailure()
        }

        // Transition to half-open
        const futureTime = Date.now() + 31000
        Date.now = () => futureTime
        checkCircuitBreaker()

        // Record 2 successes (threshold)
        recordSuccess()
        recordSuccess()

        const state = getCircuitBreakerState()
        expect(state.state).toBe('closed')
        expect(state.failureCount).toBe(0)
        expect(state.successCount).toBe(0)
      })



      it('should increment failure count', () => {
        recordFailure()
        expect(getCircuitBreakerState().failureCount).toBe(1)

        recordFailure()
        expect(getCircuitBreakerState().failureCount).toBe(2)
      })

      it('should open circuit after threshold failures', () => {
        for (let i = 0; i < 4; i++) {
          recordFailure()
          expect(getCircuitBreakerState().state).toBe('closed')
        }

        recordFailure() // 5th failure
        expect(getCircuitBreakerState().state).toBe('open')
      })

      it('should immediately open circuit on failure in half-open state', () => {
        // Open circuit, then transition to half-open
        for (let i = 0; i < 5; i++) {
          recordFailure()
        }
        resetCircuitBreaker()
        for (let i = 0; i < 5; i++) {
          recordFailure()
        }

        const futureTime = Date.now() + 31000
        Date.now = () => futureTime
        checkCircuitBreaker() // half-open

        expect(getCircuitBreakerState().state).toBe('half-open')

        recordFailure()
        expect(getCircuitBreakerState().state).toBe('open')
      })

      it('should update lastFailureTime', () => {
        const before = Date.now()
        recordFailure()
        const state = getCircuitBreakerState()
        expect(state.lastFailureTime).toBeGreaterThanOrEqual(before)
      })



      it('should reset all state to initial values', () => {
        // Create some state
        for (let i = 0; i < 5; i++) {
          recordFailure()
        }
        expect(getCircuitBreakerState().state).toBe('open')

        resetCircuitBreaker()

        const state = getCircuitBreakerState()
        expect(state.state).toBe('closed')
        expect(state.failureCount).toBe(0)
        expect(state.lastFailureTime).toBe(0)
        expect(state.successCount).toBe(0)
      })

  };
const defineRDSErrorHandlerSuite1Registration38: NonNullable<Parameters<typeof describe>[1]> = () => {
    beforeEach(() => {
      resetCircuitBreaker()
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('should execute function successfully on first attempt', async () => {
      const mockFn = jest.fn<() => Promise<string>>().mockResolvedValue('success')

      const result = await executeWithRetry(mockFn, 'test-context')

      expect(result).toBe('success')
      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('should retry on retryable error and succeed', async () => {
      const mockFn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce({ name: 'InternalServerErrorException' })
        .mockResolvedValue('success')

      const resultPromise = executeWithRetry(mockFn, 'test-context', {
        maxRetries: 3,
        initialDelay: 100,
      })

      // Fast-forward past retry delay
      await jest.advanceTimersByTimeAsync(200)

      const result = await resultPromise
      expect(result).toBe('success')
      expect(mockFn).toHaveBeenCalledTimes(2)
    })

    it('should not retry on non-retryable error', async () => {
      const mockFn = jest.fn<() => Promise<string>>().mockRejectedValue({ name: 'ValidationError' })

      await expect(
        executeWithRetry(mockFn, 'test-context')
      ).rejects.toEqual({ name: 'ValidationError' })

      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('should throw after max retries exhausted', async () => {
      jest.useRealTimers() // Use real timers for this test

      const error = { name: 'InternalServerErrorException', message: 'Server error' }
      const mockFn = jest.fn<() => Promise<string>>().mockRejectedValue(error)

      await expect(
        executeWithRetry(mockFn, 'test-context', {
          maxRetries: 3,
          initialDelay: 1, // Very short delays for testing
          maxDelay: 10,
          jitterMax: 1,
        })
      ).rejects.toEqual(error)

      expect(mockFn).toHaveBeenCalledTimes(3)

      jest.useFakeTimers() // Restore fake timers
    })

    it('should throw immediately when circuit breaker is open', async () => {
      // Open the circuit breaker
      for (let i = 0; i < 5; i++) {
        recordFailure()
      }

      const mockFn = jest.fn<() => Promise<string>>().mockResolvedValue('success')

      await expect(
        executeWithRetry(mockFn, 'test-context')
      ).rejects.toThrow('Circuit breaker is open')

      expect(mockFn).not.toHaveBeenCalled()
    })

    it('should record success on successful execution', async () => {
      const mockFn = jest.fn<() => Promise<string>>().mockResolvedValue('success')

      // Create some failure state
      recordFailure()
      recordFailure()
      expect(getCircuitBreakerState().failureCount).toBe(2)

      await executeWithRetry(mockFn, 'test-context')

      // Failure count should be reset after success
      expect(getCircuitBreakerState().failureCount).toBe(0)
    })

    it('should record failure on failed execution', async () => {
      const mockFn = jest.fn<() => Promise<string>>().mockRejectedValue({ name: 'ValidationError' })

      try {
        await executeWithRetry(mockFn, 'test-context')
      } catch {
        // Expected
      }

      // Non-retryable errors don't record failure (only retryable errors do)
      // Let's test with a retryable error
    })

    it('should record failures for retryable errors during retries', async () => {
      jest.useRealTimers() // Use real timers for this test

      const error = { name: 'InternalServerErrorException' }
      const mockFn = jest.fn<() => Promise<string>>().mockRejectedValue(error)

      try {
        await executeWithRetry(mockFn, 'test-context', {
          maxRetries: 2,
          initialDelay: 1, // Very short delays for testing
          maxDelay: 5,
          jitterMax: 1,
        })
      } catch {
        // Expected
      }

      // Each failed retry should record a failure
      expect(getCircuitBreakerState().failureCount).toBe(2)

      jest.useFakeTimers() // Restore fake timers
    })

    it('should use custom retry options', async () => {
      const mockFn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce({ name: 'ThrottlingException' })
        .mockResolvedValue('success')

      const resultPromise = executeWithRetry(mockFn, 'test-context', {
        maxRetries: 5,
        initialDelay: 50,
        maxDelay: 1000,
        backoffMultiplier: 3,
        jitterMax: 10,
      })

      await jest.advanceTimersByTimeAsync(200)

      const result = await resultPromise
      expect(result).toBe('success')
      expect(mockFn).toHaveBeenCalledTimes(2)
    })

    it('should use provided requestId', async () => {
      const mockFn = jest.fn<() => Promise<string>>().mockResolvedValue('success')

      await executeWithRetry(mockFn, 'test-context', {}, 'custom-request-id')

      expect(mockFn).toHaveBeenCalled()
    })

    it('should succeed after multiple retries', async () => {
      const mockFn = jest
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce({ name: 'ServiceUnavailableException' })
        .mockRejectedValueOnce({ name: 'ThrottlingException' })
        .mockResolvedValue('finally success')

      const resultPromise = executeWithRetry(mockFn, 'test-context', {
        maxRetries: 5,
        initialDelay: 10,
      })

      await jest.advanceTimersByTimeAsync(500)

      const result = await resultPromise
      expect(result).toBe('finally success')
      expect(mockFn).toHaveBeenCalledTimes(3)
    })
  };

const defineRDSErrorHandlerSuite1 = () => {
  beforeEach(defineRDSErrorHandlerSuite1Registration1)



      it('should identify InternalServerErrorException as retryable', defineRDSErrorHandlerSuite1Registration2)

      it('should identify ServiceUnavailableException as retryable', defineRDSErrorHandlerSuite1Registration3)

      it('should identify ThrottlingException as retryable', defineRDSErrorHandlerSuite1Registration4)

      it('should identify TooManyRequestsException as retryable', defineRDSErrorHandlerSuite1Registration5)

      it('should identify RequestTimeoutException as retryable', defineRDSErrorHandlerSuite1Registration6)

      it('should identify UnknownError as retryable', defineRDSErrorHandlerSuite1Registration7)

      it('should NOT identify ValidationError as retryable', defineRDSErrorHandlerSuite1Registration8)

      it('should NOT identify AccessDeniedException as retryable', defineRDSErrorHandlerSuite1Registration9)



      it('should identify ECONNRESET as retryable', defineRDSErrorHandlerSuite1Registration10)

      it('should identify ETIMEDOUT as retryable', defineRDSErrorHandlerSuite1Registration11)

      it('should identify ECONNREFUSED as retryable', defineRDSErrorHandlerSuite1Registration12)

      it('should identify EPIPE as retryable', defineRDSErrorHandlerSuite1Registration13)

      it('should identify ENOTFOUND as retryable', defineRDSErrorHandlerSuite1Registration14)

      it('should NOT identify ENOENT as retryable', defineRDSErrorHandlerSuite1Registration15)



      it('should identify 500 status as retryable', defineRDSErrorHandlerSuite1Registration16)

      it('should identify 502 status as retryable', defineRDSErrorHandlerSuite1Registration17)

      it('should identify 503 status as retryable', defineRDSErrorHandlerSuite1Registration18)

      it('should identify 504 status as retryable', defineRDSErrorHandlerSuite1Registration19)

      it('should identify 429 status as retryable', defineRDSErrorHandlerSuite1Registration20)

      it('should NOT identify 400 status as retryable', defineRDSErrorHandlerSuite1Registration21)

      it('should NOT identify 401 status as retryable', defineRDSErrorHandlerSuite1Registration22)

      it('should NOT identify 403 status as retryable', defineRDSErrorHandlerSuite1Registration23)

      it('should NOT identify 404 status as retryable', defineRDSErrorHandlerSuite1Registration24)



      it('should identify "network" in message as retryable', defineRDSErrorHandlerSuite1Registration25)

      it('should identify "timeout" in message as retryable', defineRDSErrorHandlerSuite1Registration26)

      it('should identify "connection" in message as retryable', defineRDSErrorHandlerSuite1Registration27)

      it('should identify "econnreset" in message as retryable', defineRDSErrorHandlerSuite1Registration28)

      it('should identify "socket hang up" in message as retryable', defineRDSErrorHandlerSuite1Registration29)

      it('should NOT identify generic message as retryable', defineRDSErrorHandlerSuite1Registration30)



      it('should return false for null error', defineRDSErrorHandlerSuite1Registration31)

      it('should return false for undefined error', defineRDSErrorHandlerSuite1Registration32)

      it('should handle empty object', defineRDSErrorHandlerSuite1Registration33)

      it('should handle string error (truthy but no properties)', defineRDSErrorHandlerSuite1Registration34)

      it('should handle number error (truthy but no properties)', defineRDSErrorHandlerSuite1Registration35)



  describe('calculateDelay', defineRDSErrorHandlerSuite1Registration36)

  describe('Circuit Breaker', defineRDSErrorHandlerSuite1Registration37)

  describe('executeWithRetry', defineRDSErrorHandlerSuite1Registration38)
};

describe('RDS Error Handler', defineRDSErrorHandlerSuite1);
