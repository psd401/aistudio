# Testing Guide

Comprehensive testing guide for AI Studio covering unit tests, integration tests, and E2E testing with Playwright.

## Quick Start

```bash
# Run all tests
npm test

# Run unit tests in watch mode
npm run test:watch

# Run E2E tests
npm run test:e2e

# Run E2E tests with UI
npm run test:e2e:ui

# Run specific test file
npm test -- path/to/test.test.ts
```

## Test Structure

```
/tests/
├── unit/                 # Unit tests for individual functions
├── integration/          # Integration tests for features
├── e2e/                  # End-to-end tests with Playwright
│   ├── working-tests.spec.ts    # CI/CD compatible tests
│   └── playwright-mcp-examples.md # MCP testing examples
└── security/             # Security-specific tests
```

## Unit Testing

### Server Actions

```typescript
import { myAction } from '@/actions/my-actions'

describe('myAction', () => {
  it('should handle successful operation', async () => {
    const result = await myAction({ param: 'value' })
    
    expect(result.isSuccess).toBe(true)
    expect(result.data).toBeDefined()
  })
  
  it('should handle validation errors', async () => {
    const result = await myAction({ param: '' })
    
    expect(result.isSuccess).toBe(false)
    expect(result.error?.code).toBe('VALIDATION_FAILED')
  })
})
```

### Mocking Dependencies

```typescript
// Mock database calls (Drizzle ORM)
jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: jest.fn().mockResolvedValue([{ id: 1 }]),
  executeTransaction: jest.fn().mockImplementation((fn) => fn(mockDb))
}))

// Mock authentication
jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: jest.fn().mockResolvedValue({
    sub: 'test-user-id',
    email: 'test@example.com'
  })
}))

// Mock AI providers
jest.mock('@/app/api/chat/lib/provider-factory', () => ({
  createProviderModel: jest.fn()
}))
```

## Integration Testing

### Database Operations

```typescript
import { executeQuery } from '@/lib/db/drizzle-client'
import { eq, like } from 'drizzle-orm'
import { users } from '@/lib/db/schema'

describe('Database Integration', () => {
  beforeEach(async () => {
    // Clean test data
    await executeQuery(
      (db) => db.delete(users).where(like(users.email, '%@test.com')),
      "cleanTestData"
    )
  })

  it('should perform CRUD operations', async () => {
    // Create
    const [created] = await executeQuery(
      (db) => db.insert(users).values({ email: "test@test.com" }).returning(),
      "createUser"
    )
    expect(created.id).toBeDefined()

    // Read
    const [found] = await executeQuery(
      (db) => db.select().from(users).where(eq(users.id, created.id)),
      "findUser"
    )
    expect(found.email).toBe("test@test.com")

    // Cleanup
    await executeQuery(
      (db) => db.delete(users).where(eq(users.id, created.id)),
      "deleteUser"
    )
  })
})
```

### API Routes

```typescript
describe('API Routes', () => {
  it('should stream chat responses', async () => {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
        modelId: 'gpt-4-turbo',
        provider: 'openai'
      })
    })
    
    expect(response.headers.get('content-type')).toContain('text/event-stream')
  })
})
```

## E2E Testing with Playwright

### Configuration

```typescript
// playwright.config.ts
export default {
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://localhost:3000',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ]
}
```

### Basic E2E Test

```typescript
import { test, expect } from '@playwright/test'

test('user can navigate to chat', async ({ page }) => {
  await page.goto('/')
  await page.click('text=Chat')
  await expect(page).toHaveURL('/chat')
  await expect(page.locator('h1')).toContainText('AI Chat')
})
```

### Authenticated Tests with Playwright MCP

When developing, use Playwright MCP for authenticated testing:

```bash
# In Claude Code terminal
/e2e-test Navigate to /admin/users and verify user table loads
/e2e-test Test chat - send "Hello" and verify response
/e2e-test Upload a PDF to /documents and verify processing
```

### CI/CD Compatible Tests

Add tests that don't require authentication to `working-tests.spec.ts`:

```typescript
test('public pages load', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('h1')).toBeVisible()
  
  await page.goto('/auth/signin')
  await expect(page.locator('text=Sign in')).toBeVisible()
})
```

## File Processing Testing

### Upload Testing

```typescript
describe('File Upload', () => {
  it('should process PDF files', async () => {
    const buffer = fs.readFileSync('test-files/sample.pdf')
    const result = await extractTextFromPDF(buffer)
    
    expect(result.text).toContain('expected content')
    expect(result.metadata.pageCount).toBeGreaterThan(0)
  })
  
  it('should handle large files', async () => {
    const largeFile = Buffer.alloc(10 * 1024 * 1024) // 10MB
    const result = await validateFileSize(largeFile, 'pdf')
    
    expect(result.isValid).toBe(true)
  })
})
```

### S3 Integration

```typescript
describe('S3 Operations', () => {
  it('should generate presigned URLs', async () => {
    const result = await generatePresignedUrl({
      key: 'test-file.pdf',
      operation: 'putObject'
    })
    
    expect(result.url).toMatch(/^https:\/\/.*amazonaws\.com/)
    expect(result.fields).toBeDefined()
  })
})
```

## Testing Best Practices

### 1. Test Organization
- Group related tests in describe blocks
- Use clear, descriptive test names
- Follow AAA pattern: Arrange, Act, Assert

### 2. Data Management
- Use test-specific data (emails ending in @test.com)
- Clean up test data in afterEach hooks
- Never use production data

### 3. Mocking Strategy
- Mock external services (AI providers, S3)
- Use real database for integration tests
- Mock time-sensitive operations

### 4. Performance Testing
```typescript
it('should complete within time limit', async () => {
  const start = Date.now()
  await performOperation()
  const duration = Date.now() - start
  
  expect(duration).toBeLessThan(1000) // 1 second
})
```

### 5. Error Testing
```typescript
it('should handle network errors gracefully', async () => {
  // Simulate network error
  jest.spyOn(global, 'fetch').mockRejectedValueOnce(
    new Error('Network error')
  )
  
  const result = await fetchData()
  expect(result.isSuccess).toBe(false)
  expect(result.error?.code).toBe('NETWORK_ERROR')
})
```

## Coverage Requirements

- Minimum 80% code coverage for new features
- 100% coverage for critical paths (auth, payments)
- Run coverage report: `npm test -- --coverage`

## Continuous Integration

Tests run automatically on:
- Pull request creation
- Commits to `dev` branch
- Pre-deployment validation

## Troubleshooting

### Common Issues

1. **Database connection errors in tests**
   - Ensure test database is running
   - Check RDS_RESOURCE_ARN in test env

2. **Flaky E2E tests**
   - Add explicit waits: `await page.waitForSelector()`
   - Increase timeout: `test.setTimeout(30000)`

3. **Mock not working**
   - Clear mock cache: `jest.clearAllMocks()`
   - Check import paths match exactly

## Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Playwright Documentation](https://playwright.dev/docs/intro)
- [Testing Library](https://testing-library.com/docs/)
- Internal: `/tests/README.md` for test utilities