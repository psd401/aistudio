/**
 * Unit tests for error handler recursion prevention
 * Issue #510: Navigation API endpoint crashes with stack overflow under load
 */

import { handleError } from '../error-utils'

describe('Error Handler Recursion Prevention', () => {
  describe('handleError - Recursion Guard', () => {
    it('should prevent infinite recursion in error handling', () => {
      // Create an error that would trigger error handling recursively
      const error = new Error('Test error')

      // This should not throw or cause stack overflow
      const result = handleError(error, 'Test message')

      expect(result.isSuccess).toBe(false)
      expect(result.message).toBeDefined()
    })

    it('should handle nested error causes without recursion', () => {
      let error: Error = new Error('Deep error level 100')
      // Create 100-level deep error chain
      for (let i = 99; i >= 0; i--) {
        const newError = new Error(`Error level ${i}`)
        ;(newError as Error & { cause?: Error }).cause = error
        error = newError
      }

      expect(() => handleError(error, 'Test message')).not.toThrow()
    })

    it('should handle circular error cause chain', () => {
      const error1 = new Error('Error 1')
      const error2 = new Error('Error 2')
      ;(error1 as Error & { cause?: Error }).cause = error2
      ;(error2 as Error & { cause?: Error }).cause = error1 // Circular

      const result = handleError(error1, 'Test message')

      expect(result.isSuccess).toBe(false)
      expect(result.message).toBe('Test message')
    })

    it('should handle Error objects with circular custom properties', () => {
      const error = new Error('Test error')
      ;(error as unknown as Record<string, unknown>).details = {
        request: {}
      }
      const details = (error as unknown as Record<string, unknown>).details as Record<string, unknown>
      details.error = error // Circular reference

      expect(() => handleError(error, 'Test message')).not.toThrow()
    })

    it('should complete error handling even with complex nested errors', () => {
      const error = new Error('Root error')
      ;(error as unknown as Record<string, unknown>).context = {
        user: { id: 1, name: 'test' },
        request: {
          headers: { authorization: 'Bearer token' },
          body: { data: 'test' }
        },
        navigation: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          label: `Item ${i}`
        }))
      }

      const result = handleError(error, 'Test message', {
        context: 'navigation-api',
        metadata: { endpoint: '/api/navigation' }
      })

      expect(result.isSuccess).toBe(false)
      expect(result).toBeDefined()
    })
  })

  describe('handleError - Error Serialization', () => {
    it('should handle AWS SDK errors with circular references', () => {
      const awsError = new Error('CredentialsProviderError')
      ;(awsError as unknown as Record<string, unknown>).name = 'CredentialsProviderError'
      ;(awsError as unknown as Record<string, unknown>).$metadata = {
        httpStatusCode: 500,
        requestId: 'test-request-id'
      }
      // Simulate AWS SDK circular pattern
      const metadata = (awsError as unknown as Record<string, unknown>).$metadata as Record<string, unknown>
      metadata.error = awsError

      const result = handleError(awsError, 'AWS error occurred')

      expect(result.isSuccess).toBe(false)
      expect(result.message).toBe('AWS error occurred')
    })

    it('should handle errors with deeply nested stack traces', () => {
      const error = new Error('Test error')
      error.stack = Array.from({ length: 1000 }, (_, i) =>
        `    at function${i} (/path/to/file${i}.ts:${i}:${i})`
      ).join('\n')

      expect(() => handleError(error, 'Test message')).not.toThrow()
    })

    it('should handle undefined and null errors gracefully', () => {
      expect(() => handleError(null, 'Null error')).not.toThrow()
      expect(() => handleError(undefined, 'Undefined error')).not.toThrow()
    })

    it('should handle errors during high load (100 concurrent calls)', async () => {
      const errors = Array.from({ length: 100 }, (_, i) =>
        new Error(`Error ${i}`)
      )

      const results = errors.map(error =>
        handleError(error, 'High load test')
      )

      expect(results).toHaveLength(100)
      results.forEach(result => {
        expect(result.isSuccess).toBe(false)
      })
    })
  })

  describe('handleError - Edge Cases', () => {
    it('should handle string errors', () => {
      const result = handleError('String error', 'Test message')

      expect(result.isSuccess).toBe(false)
      expect(result.message).toBe('Test message')
    })

    it('should handle number errors', () => {
      const result = handleError(404, 'Not found')

      expect(result.isSuccess).toBe(false)
    })

    it('should handle object errors without Error prototype', () => {
      const objError = {
        code: 'CUSTOM_ERROR',
        message: 'Custom error occurred',
        details: { foo: 'bar' }
      }

      const result = handleError(objError, 'Object error')

      expect(result.isSuccess).toBe(false)
      expect(result.message).toBe('Object error')
    })

    it('should include error in response when explicitly requested', () => {
      const error = new Error('Test error')
      const result = handleError(error, 'Test message', {
        includeErrorInResponse: true
      })

      expect(result).toHaveProperty('error')
    })

    it('should exclude error in response when explicitly disabled', () => {
      const error = new Error('Test error')
      const result = handleError(error, 'Test message', {
        includeErrorInResponse: false
      })

      expect(result).not.toHaveProperty('error')
    })
  })

  describe('handleError - Performance', () => {
    it('should complete within reasonable time for large errors', () => {
      const error = new Error('Large error')
      ;(error as unknown as Record<string, unknown>).data = {
        users: Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          name: `User ${i}`,
          email: `user${i}@example.com`
        })),
        logs: Array.from({ length: 1000 }, (_, i) =>
          `Log entry ${i}: Something happened`
        )
      }

      const startTime = Date.now()
      handleError(error, 'Large error test')
      const endTime = Date.now()

      // Should complete in less than 100ms
      expect(endTime - startTime).toBeLessThan(100)
    })

    it('should handle rapid successive error calls', () => {
      const startTime = Date.now()

      for (let i = 0; i < 1000; i++) {
        handleError(new Error(`Error ${i}`), 'Rapid test')
      }

      const endTime = Date.now()

      // 1000 calls should complete in less than 1 second
      expect(endTime - startTime).toBeLessThan(1000)
    })
  })
})
