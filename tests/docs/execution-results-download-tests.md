# Execution Results Download API Tests

This document describes the comprehensive test suite for the execution results download API endpoint at `/app/api/execution-results/[id]/download/route.ts`.

## Overview

The test suite covers all aspects of the download API functionality:

- **Authentication & Authorization**: Ensures proper access control
- **Input Validation**: Tests parameter validation and error handling
- **Markdown Generation**: Verifies correct file format and content
- **HTTP Headers**: Validates proper response headers
- **Rate Limiting**: Tests rate limit enforcement
- **Error Handling**: Covers various error scenarios
- **Performance**: Tests with large data sets and edge cases

## Test Structure

```
tests/
├── api/execution-results/[id]/
│   └── download.test.ts                    # Main API handler unit tests
├── integration/
│   └── execution-results-download.test.ts  # Full integration tests
├── unit/
│   ├── execution-results-download-utils.test.ts      # Utility function tests
│   └── execution-results-download-rate-limit.test.ts # Rate limiting tests
├── utils/
│   └── execution-result-test-data.ts       # Test data factories and utilities
├── scripts/
│   └── run-execution-results-download-tests.sh # Test runner script
└── docs/
    └── execution-results-download-tests.md # This documentation
```

## Test Categories

### 1. Unit Tests (`tests/api/execution-results/[id]/download.test.ts`)

Tests the main API handler function in isolation:

- **Authentication Tests**: Validates session requirements and user verification
- **Authorization Tests**: Ensures users can only access their own data
- **Input Validation**: Tests ID parameter validation (numeric, positive)
- **Markdown Generation**: Verifies correct markdown format for different execution states
- **Filename Generation**: Tests filename sanitization and format
- **HTTP Headers**: Validates Content-Type, Content-Disposition, Content-Length
- **Error Handling**: Database errors, invalid JSON, session failures
- **Logging**: Verifies proper logging of operations and errors

#### Key Test Scenarios:

```typescript
// Authentication failure
it('should return 401 for unauthenticated requests')

// Cross-user access prevention
it('should return 404 when user tries to access another user\'s execution result')

// Input validation
it('should return 400 for non-numeric ID')
it('should return 400 for negative ID')
it('should return 400 for zero ID')

// Successful download
it('should allow users to access their own execution results')

// Markdown content verification
it('should generate correct markdown for successful execution')
it('should generate correct markdown for failed execution')
it('should generate correct markdown for running execution')
```

### 2. Integration Tests (`tests/integration/execution-results-download.test.ts`)

Tests the complete API flow with realistic scenarios:

- **Full API Integration**: End-to-end request/response testing
- **Complex Data Handling**: Tests with various result data formats
- **Edge Cases**: Special characters, large content, malformed JSON
- **Performance Testing**: Large data sets and response times
- **Real-world Scenarios**: Multiple execution states and configurations

#### Key Integration Scenarios:

```typescript
// Complete successful flow
it('should handle complete successful download flow')

// Different execution states
it('should handle failed execution with error message')
it('should handle running execution status')

// Data format handling
it('should handle complex result data with different formats')
it('should handle malformed JSON gracefully')

// Edge cases
it('should handle edge case with very long schedule name')
it('should handle special characters in all text fields')
it('should handle very large result data efficiently')
```

### 3. Utility Function Tests (`tests/unit/execution-results-download-utils.test.ts`)

Tests internal utility functions:

- **Duration Formatting**: Tests `formatDuration()` with various time ranges
- **DateTime Formatting**: Tests `formatDateTime()` output format
- **Schedule Description**: Tests `getScheduleDescription()` logic
- **Input Data Formatting**: Tests `formatInputData()` transformation
- **Filename Sanitization**: Tests filename generation and sanitization
- **Content Length Calculation**: Tests UTF-8 byte length calculations

#### Key Utility Tests:

```typescript
// Duration formatting
it('should format execution duration correctly')
// Tests: 500ms, 1s, 1m 5s, 1h 1m 5s

// Filename sanitization
it('should sanitize special characters in schedule name')
// Tests: @#$%^&*() → sanitized version

// Markdown generation
it('should handle different result data formats in markdown')
// Tests: content, text, output fields
```

### 4. Rate Limiting Tests (`tests/unit/execution-results-download-rate-limit.test.ts`)

Tests rate limiting configuration and enforcement:

- **Configuration Validation**: Ensures correct rate limit settings
- **Enforcement Testing**: Tests rate limit exceeded scenarios
- **Header Validation**: Verifies rate limit headers in responses
- **Best Practices**: Validates rate limiting follows good practices

#### Key Rate Limiting Tests:

```typescript
// Configuration
it('should apply rate limiting with correct parameters')
// Verifies: 50 requests per minute

// Enforcement
it('should handle rate limit exceeded scenario')
it('should pass through successful requests within rate limit')

// Headers
it('should include appropriate rate limit headers in responses')
```

## Test Data Factories

The `tests/utils/execution-result-test-data.ts` file provides comprehensive test data generation:

### ExecutionResultFactory

```typescript
// Basic execution result
ExecutionResultFactory.create()

// Specific scenarios
ExecutionResultFactory.createSuccessful()
ExecutionResultFactory.createFailed()
ExecutionResultFactory.createRunning()
ExecutionResultFactory.createWithComplexInput()
ExecutionResultFactory.createWithMalformedJson()
ExecutionResultFactory.createWithSpecialChars()
ExecutionResultFactory.createWithLargeContent()
```

### UserFactory & SessionFactory

```typescript
// Create test user
const user = UserFactory.create({ id: 1, cognito_sub: 'test-user' })

// Create session for user
const session = SessionFactory.createForUser(user)
```

### Pre-built Test Scenarios

```typescript
// Complete test scenarios
const scenario = TestScenarios.successfulDownload()
// Returns: { user, session, result }

TestScenarios.failedExecution()
TestScenarios.runningExecution()
TestScenarios.crossUserAccess()
TestScenarios.unauthenticatedAccess()
TestScenarios.malformedJson()
TestScenarios.specialCharacters()
TestScenarios.largeContent()
```

## Running Tests

### Using the Test Runner Script

```bash
# Run all tests
./tests/scripts/run-execution-results-download-tests.sh

# Run specific test categories
./tests/scripts/run-execution-results-download-tests.sh unit
./tests/scripts/run-execution-results-download-tests.sh integration
./tests/scripts/run-execution-results-download-tests.sh coverage

# Full test suite with validation
./tests/scripts/run-execution-results-download-tests.sh full

# Get help
./tests/scripts/run-execution-results-download-tests.sh help
```

### Using Jest Directly

```bash
# Run all download-related tests
npm test -- tests/**/execution-results*download*.test.ts

# Run specific test file
npm test -- tests/api/execution-results/[id]/download.test.ts

# Run with coverage
npm test -- --coverage tests/api/execution-results/[id]/download.test.ts

# Run in watch mode
npm test -- --watch tests/api/execution-results/[id]/download.test.ts

# Run with verbose output
npm test -- --verbose tests/api/execution-results/[id]/download.test.ts
```

## Test Coverage Expectations

The test suite aims for comprehensive coverage:

- **Line Coverage**: >95%
- **Branch Coverage**: >90%
- **Function Coverage**: 100%
- **Statement Coverage**: >95%

### Coverage Areas:

1. **All API handler logic**: Authentication, validation, data processing
2. **All utility functions**: Markdown generation, filename creation, formatting
3. **All error paths**: Database errors, validation failures, authentication issues
4. **All success paths**: Various execution states and data formats
5. **Edge cases**: Special characters, large data, malformed input

## Mock Strategy

The tests use comprehensive mocking:

### Core Dependencies

```typescript
// Authentication
jest.mock('@/lib/auth/server-session')

// Database
jest.mock('@/lib/db/data-api-adapter')

// Logging
jest.mock('@/lib/logger')

// Rate limiting
jest.mock('@/lib/rate-limit')
```

### Mock Implementations

- **Session**: Configurable user sessions for testing different auth states
- **Database**: Controlled responses for various data scenarios
- **Logger**: Captures and verifies logging calls
- **Rate Limiter**: Tests both success and failure scenarios

## Validation Guidelines

### Before Running Tests

1. **Lint Test Files**: Ensure code quality
   ```bash
   bunx eslint tests/**/execution-results*download*.test.ts
   ```

2. **Type Check**: Verify TypeScript correctness
   ```bash
   bunx tsc --noEmit
   ```

3. **Validate Setup**: Check test configuration
   ```bash
   ./tests/scripts/run-execution-results-download-tests.sh validate
   ```

### Test Quality Checklist

- [ ] All test files follow the project's testing patterns
- [ ] Mock implementations are realistic and comprehensive
- [ ] Test data factories cover all necessary scenarios
- [ ] Error cases are thoroughly tested
- [ ] Performance edge cases are included
- [ ] Security scenarios (auth/access control) are covered
- [ ] All utility functions have dedicated tests
- [ ] Integration tests cover end-to-end workflows

## Debugging Tests

### Common Issues and Solutions

1. **Mock Import Errors**:
   - Ensure mocks are declared before imports
   - Check mock paths match actual module paths

2. **Type Errors**:
   - Verify jest.mocked() usage for typed mocks
   - Check TypeScript configuration includes test files

3. **Async Test Issues**:
   - Use proper async/await patterns
   - Handle Promise rejections appropriately

4. **Database Mock Issues**:
   - Ensure executeSQL mock returns expected data structure
   - Verify SQL parameter formatting matches expectations

### Debug Commands

```bash
# Run single test with full output
npm test -- --verbose --no-coverage tests/api/execution-results/[id]/download.test.ts

# Run with debug logging
DEBUG=* npm test -- tests/api/execution-results/[id]/download.test.ts

# Run specific test case
npm test -- --testNamePattern="should return 401 for unauthenticated requests"
```

## Contributing

When adding new tests:

1. **Follow Existing Patterns**: Use the same structure and naming conventions
2. **Add to Test Data**: Update factories for new scenarios
3. **Update Documentation**: Keep this document current
4. **Run Full Suite**: Ensure new tests don't break existing ones
5. **Check Coverage**: Maintain high coverage percentages

### Test Naming Convention

```typescript
describe('Category Name', () => {
  describe('Subcategory', () => {
    it('should do something specific', () => {
      // Test implementation
    })
  })
})
```

### Test Structure Pattern

```typescript
it('should test specific behavior', () => {
  // Arrange: Set up test data and mocks

  // Act: Execute the function/API

  // Assert: Verify the results
})
```

This comprehensive test suite ensures the execution results download API is reliable, secure, and performs well under various conditions.