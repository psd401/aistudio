/**
 * Test data factories and utilities for execution result download tests
 */

import { randomInt } from 'node:crypto'

export interface MockExecutionResult {
  id: number
  scheduled_execution_id: number
  result_data: string | null
  status: 'success' | 'failed' | 'running'
  executed_at: string
  execution_duration_ms: number
  error_message: string | null
  schedule_name: string
  user_id: number
  input_data: string
  schedule_config: string
  assistant_architect_name: string
}

export interface MockUser {
  id: number
  cognito_sub: string
}

export interface MockSession {
  sub: string
}

/**
 * Factory for creating mock execution results
 */
export class ExecutionResultFactory {
  static create(overrides: Partial<MockExecutionResult> = {}): MockExecutionResult {
    const baseResult: MockExecutionResult = {
      id: randomInt(1, 10001),
      scheduled_execution_id: randomInt(1, 10001),
      result_data: JSON.stringify({ content: 'Default test content' }),
      status: 'success',
      executed_at: new Date().toISOString(),
      execution_duration_ms: 5000,
      error_message: null,
      schedule_name: 'Test Schedule',
      user_id: 1,
      input_data: JSON.stringify({}),
      schedule_config: JSON.stringify({}),
      assistant_architect_name: 'Test Assistant',
      ...overrides
    }

    return baseResult
  }

  /**
   * Creates a successful execution result with rich content
   */
  static createSuccessful(overrides: Partial<MockExecutionResult> = {}): MockExecutionResult {
    return this.create({
      status: 'success',
      result_data: JSON.stringify({
        content: '# Analysis Report\n\n## Summary\nAnalysis completed successfully.\n\n## Results\n- Metric A: 85%\n- Metric B: 92%\n\n## Recommendations\n1. Increase efficiency\n2. Monitor trends'
      }),
      execution_duration_ms: 8500,
      schedule_name: 'Data Analysis Report',
      input_data: JSON.stringify({
        dateRange: '2025-01-01 to 2025-01-07',
        metrics: ['A', 'B'],
        format: 'detailed'
      }),
      schedule_config: JSON.stringify({
        frequency: 'weekly',
        day: 'monday',
        time: '09:00'
      }),
      assistant_architect_name: 'Analytics Assistant',
      ...overrides
    })
  }

  /**
   * Creates a failed execution result with error message
   */
  static createFailed(overrides: Partial<MockExecutionResult> = {}): MockExecutionResult {
    return this.create({
      status: 'failed',
      result_data: null,
      error_message: 'Connection timeout after 30 seconds',
      execution_duration_ms: 30000,
      schedule_name: 'Failed Process',
      assistant_architect_name: 'Process Assistant',
      ...overrides
    })
  }

  /**
   * Creates a running execution result
   */
  static createRunning(overrides: Partial<MockExecutionResult> = {}): MockExecutionResult {
    return this.create({
      status: 'running',
      result_data: null,
      error_message: null,
      execution_duration_ms: 0,
      executed_at: new Date().toISOString(),
      schedule_name: 'Long Running Process',
      assistant_architect_name: 'Batch Assistant',
      ...overrides
    })
  }

  /**
   * Creates execution result with complex input data
   */
  static createWithComplexInput(overrides: Partial<MockExecutionResult> = {}): MockExecutionResult {
    return this.create({
      input_data: JSON.stringify({
        query: 'SELECT * FROM users WHERE created_at > ?',
        parameters: ['2025-01-01'],
        options: {
          limit: 1000,
          orderBy: 'created_at DESC',
          includeDeleted: false
        },
        metadata: {
          requestId: 'req-123456',
          userAgent: 'Test Client v1.0'
        }
      }),
      schedule_config: JSON.stringify({
        cron: '0 0 * * *',
        timezone: 'America/Los_Angeles',
        retryPolicy: {
          maxRetries: 3,
          backoffMultiplier: 2
        }
      }),
      ...overrides
    })
  }

  /**
   * Creates execution result with malformed JSON
   */
  static createWithMalformedJson(overrides: Partial<MockExecutionResult> = {}): MockExecutionResult {
    return this.create({
      result_data: '{"incomplete": json',
      input_data: '{"malformed": input}',
      schedule_config: '{"bad": configuration',
      ...overrides
    })
  }

  /**
   * Creates execution result with special characters
   */
  static createWithSpecialChars(overrides: Partial<MockExecutionResult> = {}): MockExecutionResult {
    return this.create({
      schedule_name: 'Spéciäl Chars & Émojis Test 🧪',
      result_data: JSON.stringify({
        content: '# Report with émojis 🚀\n\n**Special chars**: àáâãäåæçèéêë\n\n**Symbols**: ©®™§¶†‡•…‰‹›€£¥'
      }),
      input_data: JSON.stringify({
        query: 'Spéciäl çhäräctérs tëst',
        symbols: '©®™§¶'
      }),
      assistant_architect_name: 'Spéciäl Assistant 🤖',
      ...overrides
    })
  }

  /**
   * Creates execution result with large content
   */
  static createWithLargeContent(overrides: Partial<MockExecutionResult> = {}): MockExecutionResult {
    const largeContent = 'Large data content: ' + 'A'.repeat(100000)
    return this.create({
      result_data: JSON.stringify({ content: largeContent }),
      schedule_name: 'Large Data Processing',
      execution_duration_ms: 45000,
      ...overrides
    })
  }

  /**
   * Creates execution result with different result data formats
   */
  static createWithTextFormat(overrides: Partial<MockExecutionResult> = {}): MockExecutionResult {
    return this.create({
      result_data: JSON.stringify({
        text: 'This result uses the text field instead of content'
      }),
      ...overrides
    })
  }

  static createWithOutputFormat(overrides: Partial<MockExecutionResult> = {}): MockExecutionResult {
    return this.create({
      result_data: JSON.stringify({
        output: '## Processing Complete\n\nRecords processed: 1,500\nErrors: 5\n\n### Summary\nExecution completed successfully.'
      }),
      ...overrides
    })
  }

  /**
   * Creates execution result with no standard content fields (fallback to JSON)
   */
  static createWithComplexResultData(overrides: Partial<MockExecutionResult> = {}): MockExecutionResult {
    return this.create({
      result_data: JSON.stringify({
        metadata: {
          version: '1.0',
          timestamp: '2025-01-15T10:30:00Z'
        },
        data: {
          records: [
            { id: 1, name: 'Item 1', value: 100 },
            { id: 2, name: 'Item 2', value: 200 }
          ]
        },
        summary: {
          totalRecords: 2,
          totalValue: 300
        }
      }),
      ...overrides
    })
  }
}

/**
 * Factory for creating mock users
 */
export class UserFactory {
  static create(overrides: Partial<MockUser> = {}): MockUser {
    return {
      id: randomInt(1, 1001),
      cognito_sub: `user-${randomInt(100000000, 999999999).toString(36)}`,
      ...overrides
    }
  }
}

/**
 * Factory for creating mock sessions
 */
export class SessionFactory {
  static create(overrides: Partial<MockSession> = {}): MockSession {
    return {
      sub: `user-${randomInt(100000000, 999999999).toString(36)}`,
      ...overrides
    }
  }

  static createForUser(user: MockUser): MockSession {
    return {
      sub: user.cognito_sub
    }
  }
}

/**
 * Test scenarios for comprehensive testing
 */
export const TestScenarios = {
  /**
   * Successful download scenario
   */
  successfulDownload: () => {
    const user = UserFactory.create({ id: 1, cognito_sub: 'test-user-success' })
    const session = SessionFactory.createForUser(user)
    const result = ExecutionResultFactory.createSuccessful({ user_id: user.id })
    return { user, session, result }
  },

  /**
   * Failed execution scenario
   */
  failedExecution: () => {
    const user = UserFactory.create({ id: 2, cognito_sub: 'test-user-failed' })
    const session = SessionFactory.createForUser(user)
    const result = ExecutionResultFactory.createFailed({ user_id: user.id })
    return { user, session, result }
  },

  /**
   * Running execution scenario
   */
  runningExecution: () => {
    const user = UserFactory.create({ id: 3, cognito_sub: 'test-user-running' })
    const session = SessionFactory.createForUser(user)
    const result = ExecutionResultFactory.createRunning({ user_id: user.id })
    return { user, session, result }
  },

  /**
   * Cross-user access attempt scenario
   */
  crossUserAccess: () => {
    const user = UserFactory.create({ id: 4, cognito_sub: 'test-user-4' })
    const session = SessionFactory.createForUser(user)
    const otherUserResult = ExecutionResultFactory.create({ user_id: 999 }) // Different user
    return { user, session, result: otherUserResult }
  },

  /**
   * Unauthenticated access scenario
   */
  unauthenticatedAccess: () => {
    const result = ExecutionResultFactory.create()
    return { user: null, session: null, result }
  },

  /**
   * Malformed JSON scenario
   */
  malformedJson: () => {
    const user = UserFactory.create({ id: 5, cognito_sub: 'test-user-malformed' })
    const session = SessionFactory.createForUser(user)
    const result = ExecutionResultFactory.createWithMalformedJson({ user_id: user.id })
    return { user, session, result }
  },

  /**
   * Special characters scenario
   */
  specialCharacters: () => {
    const user = UserFactory.create({ id: 6, cognito_sub: 'test-user-special' })
    const session = SessionFactory.createForUser(user)
    const result = ExecutionResultFactory.createWithSpecialChars({ user_id: user.id })
    return { user, session, result }
  },

  /**
   * Large content scenario
   */
  largeContent: () => {
    const user = UserFactory.create({ id: 7, cognito_sub: 'test-user-large' })
    const session = SessionFactory.createForUser(user)
    const result = ExecutionResultFactory.createWithLargeContent({ user_id: user.id })
    return { user, session, result }
  }
}

/**
 * Utility functions for test assertions
 */
export const TestUtils = {
  /**
   * Extracts filename from Content-Disposition header
   */
  extractFilename(contentDisposition: string | null): string | null {
    if (!contentDisposition) return null
    const match = contentDisposition.match(/filename="([^"]+)"/)
    return match ? match[1] : null
  },

  /**
   * Validates markdown structure
   */
  validateMarkdownStructure(content: string): boolean {
    const requiredSections = [
      '# ', // Title
      '**Executed:**',
      '**Schedule:**',
      '**Status:**',
      '## Results',
      '## Execution Details',
      'Generated by AI Studio'
    ]

    return requiredSections.every(section => content.includes(section))
  },

  /**
   * Validates filename format
   */
  validateFilenameFormat(filename: string): boolean {
    // Should match pattern: {schedule-name}-{YYYY-MM-DD}-{HHMM}.md
    const pattern = /^[\da-z-]+-\d{4}-\d{2}-\d{2}-\d{4}\.md$/
    return pattern.test(filename)
  },

  /**
   * Calculates expected content length
   */
  calculateContentLength(content: string): number {
    return Buffer.byteLength(content, 'utf8')
  }
}