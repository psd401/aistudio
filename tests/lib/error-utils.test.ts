/**
 * Unit tests for error utilities and factory functions
 */

import { describe, it, expect } from '@jest/globals'
import {
  ErrorFactories,
  createSuccess
} from '@/lib/error-utils'
import { ErrorCode } from '@/types/error-types'
import { ErrorLevel } from '@/types/actions-types'

describe('Error Factories', () => {
  describe('Authentication Errors', () => {
    it('creates proper typed errors with correct status codes', () => {
      const error = ErrorFactories.authNoSession()

      expect(error).toBeInstanceOf(Error)
      expect(error.code).toBe(ErrorCode.AUTH_NO_SESSION)
      expect(error.statusCode).toBe(401)
      expect(error.level).toBe(ErrorLevel.WARN)
      expect(error.retryable).toBe(false)
    })

    it('creates expired session error with correct properties', () => {
      const error = ErrorFactories.authExpiredSession()

      expect(error.code).toBe(ErrorCode.AUTH_EXPIRED_SESSION)
      expect(error.statusCode).toBe(401)
      expect(error.userMessage).toContain('expired')
    })
  })

  describe('Database Errors', () => {
    it('creates database query failed error with context', () => {
      const query = 'SELECT * FROM users WHERE id = :id'
      const originalError = new Error('Connection timeout')
      const error = ErrorFactories.dbQueryFailed(query, originalError)

      expect(error.code).toBe(ErrorCode.DB_QUERY_FAILED)
      expect(error.statusCode).toBe(500)
      expect(error.details?.query).toBe(query)
      expect(error.technicalMessage).toContain('Connection timeout')
    })

    it('creates duplicate entry error with table and field', () => {
      const error = ErrorFactories.dbDuplicateEntry('users', 'email', 'test@example.com')

      expect(error.code).toBe(ErrorCode.DB_DUPLICATE_ENTRY)
      expect(error.statusCode).toBe(409)
      expect(error.details?.table).toBe('users')
      expect(error.details?.field).toBe('email')
    })
  })

  describe('Validation Errors', () => {
    it('creates validation error with field details', () => {
      const fieldErrors = [
        { field: 'email', message: 'Invalid email format', value: 'not-an-email' },
        { field: 'age', message: 'Must be a positive number', value: -5 }
      ]

      const error = ErrorFactories.validationFailed(fieldErrors)

      expect(error.code).toBe(ErrorCode.VALIDATION_FAILED)
      expect(error.statusCode).toBe(400)
      expect(error.fields).toHaveLength(2)
      expect(error.fields?.[0].field).toBe('email')
      expect(error.level).toBe(ErrorLevel.INFO)
    })
  })

  describe('Authorization Errors', () => {
    it('creates insufficient permissions error', () => {
      const error = ErrorFactories.authzInsufficientPermissions('admin', ['user', 'staff'])

      expect(error.code).toBe(ErrorCode.AUTHZ_INSUFFICIENT_PERMISSIONS)
      expect(error.statusCode).toBe(403)
      expect(error.requiredRole).toBe('admin')
      expect(error.userRoles).toEqual(['user', 'staff'])
    })

    it('creates admin required error', () => {
      const error = ErrorFactories.authzAdminRequired()

      expect(error.code).toBe(ErrorCode.AUTHZ_ADMIN_REQUIRED)
      expect(error.statusCode).toBe(403)
      expect(error.userMessage).toContain('Administrator')
    })
  })
})

describe('Error Retryability', () => {
  it('correctly identifies retryable errors', () => {
    const retryableError = ErrorFactories.dbConnectionFailed()
    const nonRetryableError = ErrorFactories.authNoSession()

    expect(retryableError.retryable).toBe(true)
    expect(nonRetryableError.retryable).toBe(false)
  })

  it('marks timeout errors as retryable', () => {
    const timeoutError = ErrorFactories.externalServiceTimeout('API Gateway', 5000)
    expect(timeoutError.retryable).toBe(true)
  })

  it('marks rate limit errors as retryable', () => {
    const rateLimitError = ErrorFactories.externalApiRateLimit('OpenAI API')
    expect(rateLimitError.retryable).toBe(true)
  })
})

describe('Success Response Creation', () => {
  it('creates success response with data', () => {
    const data = { id: 1, name: 'Test' }
    const result = createSuccess(data, 'Operation successful')

    expect(result.isSuccess).toBe(true)
    expect(result.message).toBe('Operation successful')
    expect(result.data).toEqual(data)
  })

  it('creates success response without explicit message', () => {
    const data = [1, 2, 3]
    const result = createSuccess(data)

    expect(result.isSuccess).toBe(true)
    expect(result.message).toBe('Operation successful')
    expect(result.data).toEqual(data)
  })
})

describe('Error Level Mapping', () => {
  it('maps validation errors to INFO level', () => {
    const validationErrors = [
      ErrorFactories.validationFailed([]),
      ErrorFactories.invalidInput('field', 'value'),
      ErrorFactories.missingRequiredField('name'),
      ErrorFactories.invalidFormat('email', 'not-an-email', 'email'),
      ErrorFactories.valueOutOfRange('age', -5, 0, 120),
      ErrorFactories.invalidFileType('document', 'exe', ['pdf', 'doc']),
      ErrorFactories.fileTooLarge('image', 10485760, 5242880)
    ]

    for (const error of validationErrors) {
      expect(error.level).toBe(ErrorLevel.INFO)
    }
  })

  it('maps authentication errors to WARN level', () => {
    const authErrors = [
      ErrorFactories.authNoSession(),
      ErrorFactories.authInvalidToken(),
      ErrorFactories.authExpiredSession()
    ]

    for (const error of authErrors) {
      expect(error.level).toBe(ErrorLevel.WARN)
    }
  })

  it('maps system errors to FATAL level', () => {
    const error = ErrorFactories.sysInternalError('Critical failure')
    expect(error.level).toBe(ErrorLevel.FATAL)
  })
})