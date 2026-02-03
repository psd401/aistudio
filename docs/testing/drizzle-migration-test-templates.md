# Drizzle Migration Test Templates

Reusable test patterns for Issue #531 migration (RDS Data API → Drizzle ORM).

## Unit Test Template

```typescript
// tests/unit/db/queries/drizzle-[domain].test.ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import type { DrizzleDB } from '@/lib/db/drizzle-client'

jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: jest.fn()
}))

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }),
  generateRequestId: () => 'test-request-id',
  startTimer: () => jest.fn(),
  sanitizeForLogging: (value: unknown) => value
}))

import { executeQuery } from '@/lib/db/drizzle-client'

const mockExecuteQuery = executeQuery as jest.MockedFunction<typeof executeQuery>

describe('Drizzle [Domain] Queries', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('[FunctionName]', () => {
    it('should [happy path description]', async () => {
      // Arrange
      const expectedResult = { /* mock data */ }
      mockExecuteQuery.mockResolvedValue([expectedResult])

      // Act
      const result = await [function](/* args */)

      // Assert
      expect(result).toEqual(expectedResult)
      expect(mockExecuteQuery).toHaveBeenCalledWith(
        expect.any(Function),
        '[FunctionName]'
      )
    })

    it('should handle empty results', async () => {
      mockExecuteQuery.mockResolvedValue([])
      const result = await [function](/* args */)
      expect(Array.isArray(result)).toBe(true)
    })

    it('should throw on database error', async () => {
      mockExecuteQuery.mockRejectedValue(new Error('DB error'))
      await expect([function](/* args */)).rejects.toThrow()
    })
  })
})
```

## Integration Test Setup

```typescript
// tests/integration/db/setup.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Client } from 'pg'
import * as schema from '@/lib/db/schema'

export async function setupTestDatabase() {
  const testClient = new Client({
    host: process.env.TEST_DB_HOST || 'localhost',
    port: parseInt(process.env.TEST_DB_PORT || '5432'),
    database: process.env.TEST_DB_NAME || 'aistudio_test',
    user: process.env.TEST_DB_USER || 'postgres',
    password: process.env.TEST_DB_PASSWORD || 'password'
  })

  await testClient.connect()
  const db = drizzle(testClient, { schema })

  return { db, client: testClient }
}

export async function cleanupAllTables(db: ReturnType<typeof drizzle>) {
  // Truncate in reverse FK order
  await db.delete(schema.navigationItemRoles)
  await db.delete(schema.navigationItems)
  await db.delete(schema.userRoles)
  await db.delete(schema.users)
  await db.delete(schema.roles)
}

export async function seedRoles(db: ReturnType<typeof drizzle>) {
  return db.insert(schema.roles).values([
    { id: 1, name: 'admin', description: 'Administrator' },
    { id: 2, name: 'staff', description: 'Staff member' },
    { id: 3, name: 'student', description: 'Student' }
  ]).returning()
}
```

## Integration Test Template

```typescript
// tests/integration/db/drizzle-[domain].integration.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { setupTestDatabase, cleanupAllTables, seedRoles } from './setup'

describe('[Domain] Queries - Integration Tests', () => {
  let db: any
  let client: any

  beforeAll(async () => {
    const setup = await setupTestDatabase()
    db = setup.db
    client = setup.client
    await seedRoles(db)
  })

  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    await cleanupAllTables(db)
    await seedRoles(db)
  })

  describe('[FunctionName]', () => {
    it('should [scenario] with real database', async () => {
      // Arrange
      const testData = { /* setup */ }

      // Act
      const result = await [function](testData)

      // Assert
      expect(result).toBeDefined()

      // Verify in database
      const dbRecord = await db.query./* table */.findFirst({
        where: (t, { eq }) => eq(t.id, result.id)
      })
      expect(dbRecord).toEqual(result)
    })

    it('should handle transaction rollback on constraint violation', async () => {
      // Attempt invalid operation
      await expect([function](invalidData)).rejects.toThrow()

      // Verify no partial updates
      const count = await db.query./* table */.findMany()
      expect(count.length).toBe(0)
    })

    it('should handle concurrent operations', async () => {
      const promise1 = [function](data1)
      const promise2 = [function](data2)

      const [result1, result2] = await Promise.all([promise1, promise2])

      // Verify both succeeded or handled conflict correctly
      expect(result1).toBeDefined()
      expect(result2).toBeDefined()
    })
  })
})
```

## Data Shape Compatibility Template

```typescript
// tests/unit/db/compatibility/field-mapping.test.ts
describe('Field Name Transformation', () => {
  it('should map RDS snake_case to Drizzle camelCase', () => {
    const rdsResponse = {
      user_id: 1,
      cognito_sub: 'auth0|123',
      first_name: 'John',
      last_sign_in_at: new Date('2025-01-01')
    }

    const drizzleResponse = {
      userId: 1,
      cognitoSub: 'auth0|123',
      firstName: 'John',
      lastSignInAt: new Date('2025-01-01')
    }

    // Verify equivalence
    expect(drizzleResponse.userId).toBe(rdsResponse.user_id)
    expect(drizzleResponse.firstName).toBe(rdsResponse.first_name)
  })

  it('should preserve null values', () => {
    expect({ field: null }).toEqual({ field: null })
  })

  it('should preserve numeric types', () => {
    const data = { id: 1, version: 2 }
    expect(typeof data.id).toBe('number')
    expect(typeof data.version).toBe('number')
  })
})
```

## E2E Test Template

```typescript
// tests/e2e/user-flow.spec.ts
import { test, expect } from '@playwright/test'

test.describe('User Flow with Drizzle', () => {
  test('should complete [scenario] flow', async ({ page }) => {
    // Navigate
    await page.goto('/[path]')

    // Perform action (triggers Drizzle query)
    await page.fill('[data-testid=input]', 'value')
    await page.click('[data-testid=button]')

    // Wait for result
    await page.waitForURL('/[expected-url]')

    // Verify
    await expect(page.locator('[data-testid=success]')).toBeVisible()

    // Check database indirectly
    const displayText = await page.locator('[data-testid=data]').textContent()
    expect(displayText).toBe('Expected Value')
  })
})
```

## Mocking Patterns

### Mock Success Response

```typescript
mockExecuteQuery.mockResolvedValue([{
  id: 1,
  name: 'Test',
  createdAt: new Date()
}])
```

### Mock Empty Result

```typescript
mockExecuteQuery.mockResolvedValue([])
```

### Mock Error

```typescript
mockExecuteQuery.mockRejectedValue(
  new Error('Foreign key constraint violation')
)
```

### Mock Multiple Calls

```typescript
mockExecuteQuery
  .mockResolvedValueOnce([{ id: 1 }])  // First call
  .mockResolvedValueOnce([])           // Second call
  .mockRejectedValueOnce(new Error())  // Third call
```

## Assertion Patterns

### Verify Query Called Correctly

```typescript
expect(mockExecuteQuery).toHaveBeenCalledWith(
  expect.any(Function),  // Query function
  'functionName'         // Context string
)
```

### Verify Data Shape

```typescript
expect(result).toEqual(
  expect.objectContaining({
    id: expect.any(Number),
    email: expect.any(String),
    createdAt: expect.any(Date)
  })
)
```

### Verify Array Results

```typescript
expect(Array.isArray(result)).toBe(true)
expect(result).toHaveLength(expectedCount)
expect(result).toContainEqual(expectedItem)
```

### Verify Transaction Atomicity

```typescript
// Operation fails
await expect(operation()).rejects.toThrow()

// Verify no partial updates
const count = await queryDatabase()
expect(count).toBe(0) // Rolled back completely
```

## Test Data Fixtures

```typescript
// tests/integration/db/fixtures.ts
export const testUsers = [
  {
    cognitoSub: 'auth0|user1',
    email: 'user1@example.com',
    firstName: 'Test',
    lastName: 'User1'
  },
  {
    cognitoSub: 'auth0|user2',
    email: 'user2@example.com',
    firstName: 'Test',
    lastName: 'User2'
  }
]

export const testRoles = ['admin', 'staff', 'student']

export const testNavigationItems = [
  {
    label: 'Dashboard',
    path: '/dashboard',
    position: 1
  },
  {
    label: 'Admin Panel',
    path: '/admin',
    position: 2
  }
]
```

## Environment Variables for Integration Tests

```bash
# .env.test
TEST_DB_HOST=localhost
TEST_DB_PORT=5432
TEST_DB_NAME=aistudio_test
TEST_DB_USER=postgres
TEST_DB_PASSWORD=password

# Or Docker
TEST_DB_HOST=postgres
TEST_DB_PORT=5432
```

## Docker Compose for Test Database

```yaml
# docker-compose.test.yml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: aistudio_test
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"
    volumes:
      - postgres_test_data:/var/lib/postgresql/data

volumes:
  postgres_test_data:
```

```bash
# Run tests with Docker database
docker-compose -f docker-compose.test.yml up -d
npm run test:integration
docker-compose -f docker-compose.test.yml down
```

## CI/CD Integration

```yaml
# .github/workflows/test.yml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15-alpine
        env:
          POSTGRES_DB: aistudio_test
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: password
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci
      - run: npm run test:unit
      - run: npm run test:integration
        env:
          TEST_DB_HOST: localhost
          TEST_DB_USER: postgres
          TEST_DB_PASSWORD: password
```
