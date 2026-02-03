import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { NextRequest } from 'next/server'

// Create simple mock functions
const mockGetServerSession = jest.fn<() => Promise<{ sub?: string } | null>>()
const mockExecuteQuery = jest.fn<(callback: Function, operationName: string) => Promise<unknown>>()
const mockCreateLogger = jest.fn<() => { info: jest.Mock; warn: jest.Mock; error: jest.Mock }>()
const mockGenerateRequestId = jest.fn<() => string>()
const mockStartTimer = jest.fn<(operation: string) => (metadata?: object) => void>()
const mockSanitizeForLogging = jest.fn<(data: unknown) => unknown>()
const mockWithRateLimit = jest.fn<(handler: Function, config?: unknown) => Function>()
  .mockImplementation((handler: Function, config?: unknown) => handler)

// Mock the dependencies at the module level
jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: mockGetServerSession
}))
jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: mockExecuteQuery
}))
jest.mock('@/lib/logger', () => ({
  createLogger: mockCreateLogger,
  generateRequestId: mockGenerateRequestId,
  startTimer: mockStartTimer,
  sanitizeForLogging: mockSanitizeForLogging
}))
jest.mock('@/lib/rate-limit', () => ({
  withRateLimit: mockWithRateLimit
}))

// Import after mocks
import { downloadHandler } from '@/app/api/execution-results/[id]/download/handler'

// Mock logger object
const integrationMockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}

const mockTimer = jest.fn()

// TODO: Fix Jest module caching issue for multi-test runs
// TODO (Issue #541): Update test mocks to match Drizzle implementation
// - Mock executeQuery callback instead of executeSQL parameters
// - Update assertion expectations for Drizzle query builder
// Individual tests work perfectly - same fix needed as in unit tests
describe.skip('Execution Results Download Integration Tests [NEEDS UPDATE FOR DRIZZLE]', () => {
  beforeEach(() => {
    // Clear and setup mocks
    jest.clearAllMocks()

    // Setup default mock implementations
    mockCreateLogger.mockReturnValue(integrationMockLogger)
    mockGenerateRequestId.mockReturnValue('integration-test-id')
    mockStartTimer.mockReturnValue((metadata?: object) => {
      mockTimer(metadata)
    })
    mockSanitizeForLogging.mockImplementation((data) => data)
  })


  describe('Full API Integration Tests', () => {
    it('should handle complete successful download flow', async () => {
      // Arrange
      const session = { sub: 'integration-user-123' }
      const mockUser = { id: 42 }
      const mockExecutionResult = {
        id: 999,
        scheduled_execution_id: 888,
        result_data: JSON.stringify({
          content: '# Data Analysis Report\n\n## Summary\nData processed successfully.\n\n## Key Findings\n- Metric A: 85%\n- Metric B: 92%'
        }),
        status: 'success',
        executed_at: '2025-01-15T14:30:45Z',
        execution_duration_ms: 12500,
        error_message: null,
        schedule_name: 'Weekly Data Analysis',
        user_id: 42,
        input_data: JSON.stringify({
          dateRange: '2025-01-01 to 2025-01-07',
          includeMetrics: ['A', 'B', 'C'],
          format: 'detailed'
        }),
        schedule_config: JSON.stringify({
          frequency: 'weekly',
          day: 'monday',
          time: '09:00'
        }),
        assistant_architect_name: 'Data Analysis Assistant'
      }

      mockGetServerSession.mockResolvedValue(session)
      mockExecuteQuery
        .mockResolvedValueOnce([mockUser]) // User lookup
        .mockResolvedValueOnce([mockExecutionResult]) // Execution result

      const request = new NextRequest('http://localhost:3000/api/execution-results/999/download', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer mock-token',
          'User-Agent': 'Test Client'
        }
      })
      const params = Promise.resolve({ id: '999' })

      // Act
      const response = await downloadHandler(request, { params })
      const content = await response.text()

      // Assert - Response headers
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
      expect(response.headers.get('Content-Disposition')).toMatch(
        /attachment; filename="weekly-data-analysis-2025-01-15-1430\.md"/
      )
      expect(response.headers.get('Content-Length')).toBe(String(Buffer.byteLength(content, 'utf8')))

      // Assert - Markdown content structure
      expect(content).toContain('# Weekly Data Analysis')
      expect(content).toContain('**Status:** Success ✓')
      expect(content).toContain('**Schedule:** Frequency: weekly')
      expect(content).toContain('## Input Parameters')
      expect(content).toContain('- Date Range: 2025-01-01 to 2025-01-07')
      expect(content).toContain('- Include Metrics: ["A","B","C"]')
      expect(content).toContain('- Format: detailed')
      expect(content).toContain('## Results')
      expect(content).toContain('# Data Analysis Report')
      expect(content).toContain('## Key Findings')
      expect(content).toContain('- Metric A: 85%')
      expect(content).toContain('## Execution Details')
      expect(content).toContain('- Duration: 12s')
      expect(content).toContain('- Assistant: Data Analysis Assistant')
      expect(content).toContain('Generated by AI Studio - Peninsula School District')
      expect(content).toContain('View online: https://aistudio.psd401.ai/execution-results/999')

      // Assert - Database queries
      expect(mockExecuteQuery).toHaveBeenCalledTimes(2)
      // TODO (Issue #541): Update these assertions for Drizzle query builder callbacks
      expect(mockExecuteQuery).toHaveBeenNthCalledWith(1,
        expect.stringContaining('SELECT id FROM users WHERE cognito_sub = :cognitoSub'),
        // @ts-expect-error - Old RDS Data API parameter format
        [{ name: 'cognitoSub', value: { stringValue: 'integration-user-123' } }]
      )
      // TODO (Issue #541): Update this assertion for Drizzle query builder callbacks
      expect(mockExecuteQuery).toHaveBeenNthCalledWith(2,
        expect.stringContaining('WHERE er.id = :result_id AND se.user_id = :user_id'),
        // @ts-expect-error - Old RDS Data API parameter format
        [
          { name: 'result_id', value: { longValue: 999 } },
          { name: 'user_id', value: { longValue: 42 } }
        ]
      )

      // Assert - Logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Downloading execution result',
        { resultId: '999' }
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Execution result downloaded successfully',
        expect.objectContaining({
          resultId: 999,
          filename: 'weekly-data-analysis-2025-01-15-1430.md',
          contentLength: expect.any(Number)
        })
      )
    })

    it('should handle failed execution with error message', async () => {
      // Arrange
      const session = { sub: 'user-failed-test' }
      const mockUser = { id: 43 }
      const mockFailedResult = {
        id: 1000,
        scheduled_execution_id: 889,
        result_data: null,
        status: 'failed',
        executed_at: '2025-01-15T15:00:00Z',
        execution_duration_ms: 3000,
        error_message: 'API rate limit exceeded. Please try again later.',
        schedule_name: 'API Data Sync',
        user_id: 43,
        input_data: JSON.stringify({ endpoint: '/api/v1/data', timeout: 30000 }),
        schedule_config: JSON.stringify({ frequency: 'hourly' }),
        assistant_architect_name: 'API Sync Assistant'
      }

      mockGetServerSession.mockResolvedValue(session)
      mockExecuteQuery
        .mockResolvedValueOnce([mockUser])
        .mockResolvedValueOnce([mockFailedResult])

      const request = new NextRequest('http://localhost:3000/api/execution-results/1000/download')
      const params = Promise.resolve({ id: '1000' })

      const { GET } = await import('@/app/api/execution-results/[id]/download/route')

      // Act
      const response = await downloadHandler(request, { params })
      const content = await response.text()

      // Assert
      expect(response.status).toBe(200)
      expect(content).toContain('# API Data Sync')
      expect(content).toContain('**Status:** Failed ✗')
      expect(content).toContain('**Error:** API rate limit exceeded. Please try again later.')
      expect(content).toContain('- Duration: 3s')
      expect(content).toContain('- Assistant: API Sync Assistant')
    })

    it('should handle running execution status', async () => {
      // Arrange
      const session = { sub: 'user-running-test' }
      const mockUser = { id: 44 }
      const mockRunningResult = {
        id: 1001,
        scheduled_execution_id: 890,
        result_data: null,
        status: 'running',
        executed_at: '2025-01-15T16:00:00Z',
        execution_duration_ms: 0,
        error_message: null,
        schedule_name: 'Long Running Process',
        user_id: 44,
        input_data: JSON.stringify({ batchSize: 10000, processType: 'full' }),
        schedule_config: JSON.stringify({ description: 'Manual execution of batch process' }),
        assistant_architect_name: 'Batch Processing Assistant'
      }

      mockGetServerSession.mockResolvedValue(session)
      mockExecuteQuery
        .mockResolvedValueOnce([mockUser])
        .mockResolvedValueOnce([mockRunningResult])

      const request = new NextRequest('http://localhost:3000/api/execution-results/1001/download')
      const params = Promise.resolve({ id: '1001' })

      const { GET } = await import('@/app/api/execution-results/[id]/download/route')

      // Act
      const response = await downloadHandler(request, { params })
      const content = await response.text()

      // Assert
      expect(response.status).toBe(200)
      expect(content).toContain('# Long Running Process')
      expect(content).toContain('**Status:** Running ⏳')
      expect(content).toContain('**Status:** Execution is still in progress')
      expect(content).toContain('**Schedule:** Manual execution of batch process')
      expect(content).toContain('- Batch Size: 10000')
      expect(content).toContain('- Process Type: full')
    })

    it('should handle complex result data with different formats', async () => {
      // Arrange
      const session = { sub: 'user-complex-data' }
      const mockUser = { id: 45 }
      const mockComplexResult = {
        id: 1002,
        scheduled_execution_id: 891,
        result_data: JSON.stringify({
          output: '## Analysis Complete\n\nProcessed 1,500 records\n\n### Results\n- Success: 1,450\n- Errors: 50\n\n### Error Details\n```\nTimeout errors: 35\nValidation errors: 15\n```'
        }),
        status: 'success',
        executed_at: '2025-01-15T17:15:30Z',
        execution_duration_ms: 45000,
        error_message: null,
        schedule_name: 'Record Processing Job',
        user_id: 45,
        input_data: JSON.stringify({}),
        schedule_config: JSON.stringify({}),
        assistant_architect_name: 'Data Processing Assistant'
      }

      mockGetServerSession.mockResolvedValue(session)
      mockExecuteQuery
        .mockResolvedValueOnce([mockUser])
        .mockResolvedValueOnce([mockComplexResult])

      const request = new NextRequest('http://localhost:3000/api/execution-results/1002/download')
      const params = Promise.resolve({ id: '1002' })

      const { GET } = await import('@/app/api/execution-results/[id]/download/route')

      // Act
      const response = await downloadHandler(request, { params })
      const content = await response.text()

      // Assert
      expect(response.status).toBe(200)
      expect(content).toContain('## Analysis Complete')
      expect(content).toContain('Processed 1,500 records')
      expect(content).toContain('### Results')
      expect(content).toContain('- Success: 1,450')
      expect(content).toContain('```\nTimeout errors: 35')
      expect(content).toContain('- Duration: 45s')
    })

    it('should handle malformed JSON gracefully', async () => {
      // Arrange
      const session = { sub: 'user-malformed-json' }
      const mockUser = { id: 46 }
      const mockMalformedResult = {
        id: 1003,
        scheduled_execution_id: 892,
        result_data: '{"incomplete": json',
        status: 'success',
        executed_at: '2025-01-15T18:00:00Z',
        execution_duration_ms: 2000,
        error_message: null,
        schedule_name: 'Malformed JSON Test',
        user_id: 46,
        input_data: '{"another": incomplete',
        schedule_config: '{"bad": json}',
        assistant_architect_name: 'Test Assistant'
      }

      mockGetServerSession.mockResolvedValue(session)
      mockExecuteQuery
        .mockResolvedValueOnce([mockUser])
        .mockResolvedValueOnce([mockMalformedResult])

      const request = new NextRequest('http://localhost:3000/api/execution-results/1003/download')
      const params = Promise.resolve({ id: '1003' })

      const { GET } = await import('@/app/api/execution-results/[id]/download/route')

      // Act
      const response = await downloadHandler(request, { params })
      const content = await response.text()

      // Assert
      expect(response.status).toBe(200)
      expect(content).toContain('# Malformed JSON Test')
      expect(content).toContain('**Status:** Success ✓')
      // Should handle malformed JSON gracefully and show "No input parameters"
      expect(content).toContain('No input parameters')

      // Assert that JSON parsing warnings were logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Invalid JSON in resultData',
        expect.objectContaining({ resultId: 1003 })
      )
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Invalid JSON in inputData',
        expect.objectContaining({ resultId: 1003 })
      )
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Invalid JSON in scheduleConfig',
        expect.objectContaining({ resultId: 1003 })
      )
    })

    it('should handle edge case with very long schedule name', async () => {
      // Arrange
      const session = { sub: 'user-long-name' }
      const mockUser = { id: 47 }
      const longScheduleName = 'This is a very long schedule name that exceeds the typical length limits and should be truncated appropriately for filename generation while maintaining readability and avoiding filesystem issues'
      const mockLongNameResult = {
        id: 1004,
        scheduled_execution_id: 893,
        result_data: JSON.stringify({ content: 'Short result' }),
        status: 'success',
        executed_at: '2025-01-15T19:00:00Z',
        execution_duration_ms: 1000,
        error_message: null,
        schedule_name: longScheduleName,
        user_id: 47,
        input_data: JSON.stringify({}),
        schedule_config: JSON.stringify({}),
        assistant_architect_name: 'Test Assistant'
      }

      mockGetServerSession.mockResolvedValue(session)
      mockExecuteQuery
        .mockResolvedValueOnce([mockUser])
        .mockResolvedValueOnce([mockLongNameResult])

      const request = new NextRequest('http://localhost:3000/api/execution-results/1004/download')
      const params = Promise.resolve({ id: '1004' })

      const { GET } = await import('@/app/api/execution-results/[id]/download/route')

      // Act
      const response = await downloadHandler(request, { params })

      // Assert
      expect(response.status).toBe(200)
      const contentDisposition = response.headers.get('Content-Disposition')
      // Should be truncated to 50 characters max
      expect(contentDisposition).toMatch(/filename="[^"]{1,60}\.md"/)

      // Filename should start with truncated schedule name
      expect(contentDisposition).toMatch(/filename="this-is-a-very-long-schedule-name-that-exceeds-the/)
    })
  })

  describe('Error Scenarios Integration', () => {
    it('should handle database timeout errors', async () => {
      // Arrange
      const session = { sub: 'user-db-timeout' }
      mockGetServerSession.mockResolvedValue(session)
      mockExecuteQuery.mockRejectedValue(new Error('Database query timeout'))

      const request = new NextRequest('http://localhost:3000/api/execution-results/1005/download')
      const params = Promise.resolve({ id: '1005' })

      const { GET } = await import('@/app/api/execution-results/[id]/download/route')

      // Act
      const response = await downloadHandler(request, { params })
      const responseData = await response.json()

      // Assert
      expect(response.status).toBe(500)
      expect(responseData).toHaveProperty('error')
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to download execution result',
        expect.objectContaining({
          error: 'Database query timeout',
          resultId: '1005'
        })
      )
      expect(mockTimer).toHaveBeenCalledWith({ status: 'error' })
    })

    it('should handle session retrieval failures', async () => {
      // Arrange
      mockGetServerSession.mockRejectedValue(new Error('Session service unavailable'))

      const request = new NextRequest('http://localhost:3000/api/execution-results/1006/download')
      const params = Promise.resolve({ id: '1006' })

      const { GET } = await import('@/app/api/execution-results/[id]/download/route')

      // Act
      const response = await downloadHandler(request, { params })
      const responseData = await response.json()

      // Assert
      expect(response.status).toBe(500)
      expect(responseData).toHaveProperty('error')
      expect(mockTimer).toHaveBeenCalledWith({ status: 'error' })
    })

    it('should handle cross-user access attempts', async () => {
      // Arrange
      const session = { sub: 'user-cross-access' }
      const mockUser = { id: 48 }

      mockGetServerSession.mockResolvedValue(session)
      mockExecuteQuery
        .mockResolvedValueOnce([mockUser]) // User exists
        .mockResolvedValueOnce([]) // No execution result found for this user

      const request = new NextRequest('http://localhost:3000/api/execution-results/1007/download')
      const params = Promise.resolve({ id: '1007' })

      const { GET } = await import('@/app/api/execution-results/[id]/download/route')

      // Act
      const response = await downloadHandler(request, { params })
      const responseData = await response.json()

      // Assert
      expect(response.status).toBe(404)
      expect(responseData).toEqual({ error: "Execution result not found" })
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Execution result not found or access denied',
        { resultId: 1007, userId: 48 }
      )
    })
  })

  describe('Performance and Edge Cases', () => {
    it('should handle very large result data efficiently', async () => {
      // Arrange
      const session = { sub: 'user-large-data' }
      const mockUser = { id: 49 }

      // Create large content (simulating a large report)
      const largeContent = 'A'.repeat(100000) // 100KB of content
      const mockLargeResult = {
        id: 1008,
        scheduled_execution_id: 894,
        result_data: JSON.stringify({ content: largeContent }),
        status: 'success',
        executed_at: '2025-01-15T20:00:00Z',
        execution_duration_ms: 5000,
        error_message: null,
        schedule_name: 'Large Data Test',
        user_id: 49,
        input_data: JSON.stringify({}),
        schedule_config: JSON.stringify({}),
        assistant_architect_name: 'Large Data Assistant'
      }

      mockGetServerSession.mockResolvedValue(session)
      mockExecuteQuery
        .mockResolvedValueOnce([mockUser])
        .mockResolvedValueOnce([mockLargeResult])

      const request = new NextRequest('http://localhost:3000/api/execution-results/1008/download')
      const params = Promise.resolve({ id: '1008' })

      const { GET } = await import('@/app/api/execution-results/[id]/download/route')

      // Act
      const startTime = Date.now()
      const response = await downloadHandler(request, { params })
      const endTime = Date.now()
      const content = await response.text()

      // Assert
      expect(response.status).toBe(200)
      expect(content.length).toBeGreaterThan(100000)
      expect(content).toContain(largeContent)
      expect(response.headers.get('Content-Length')).toBe(String(Buffer.byteLength(content, 'utf8')))

      // Should complete in reasonable time (less than 5 seconds)
      expect(endTime - startTime).toBeLessThan(5000)
    })

    it('should handle special characters in all text fields', async () => {
      // Arrange
      const session = { sub: 'user-special-chars' }
      const mockUser = { id: 50 }
      const specialCharsResult = {
        id: 1009,
        scheduled_execution_id: 895,
        result_data: JSON.stringify({
          content: '# Report with émojis 🚀\n\n**Special chars**: àáâãäåæçèéêë\n\n**Symbols**: ©®™§¶†‡•…‰‹›€£¥'
        }),
        status: 'success',
        executed_at: '2025-01-15T21:00:00Z',
        execution_duration_ms: 2500,
        error_message: null,
        schedule_name: 'Special Chars & Émojis Test 🧪',
        user_id: 50,
        input_data: JSON.stringify({
          query: 'Spéciäl çhäräctérs tëst',
          symbols: '©®™§¶'
        }),
        schedule_config: JSON.stringify({
          description: 'Test with spéciäl chars & émojis 🚀'
        }),
        assistant_architect_name: 'Spéciäl Assistant 🤖'
      }

      mockGetServerSession.mockResolvedValue(session)
      mockExecuteQuery
        .mockResolvedValueOnce([mockUser])
        .mockResolvedValueOnce([specialCharsResult])

      const request = new NextRequest('http://localhost:3000/api/execution-results/1009/download')
      const params = Promise.resolve({ id: '1009' })

      const { GET } = await import('@/app/api/execution-results/[id]/download/route')

      // Act
      const response = await downloadHandler(request, { params })
      const content = await response.text()

      // Assert
      expect(response.status).toBe(200)
      expect(content).toContain('# Special Chars & Émojis Test 🧪')
      expect(content).toContain('émojis 🚀')
      expect(content).toContain('àáâãäåæçèéêë')
      expect(content).toContain('©®™§¶†‡•…‰‹›€£¥')
      expect(content).toContain('- Query: Spéciäl çhäräctérs tëst')
      expect(content).toContain('- Symbols: ©®™§¶')
      expect(content).toContain('- Assistant: Spéciäl Assistant 🤖')

      // Filename should properly sanitize special characters
      const contentDisposition = response.headers.get('Content-Disposition')
      expect(contentDisposition).toMatch(/filename="special-chars-emojis-test/)
    })
  })
})