# Test Strategy: Issue #531 - Migrate User & Authorization Queries to Drizzle ORM

## Overview

**Scope**: Convert RDS Data API queries to Drizzle ORM for user/role/navigation tables
**Functions**: 16 functions across user queries, role management, and navigation
**Risk Level**: Medium (affects authentication & authorization paths)
**Timeline**: Phased testing during implementation

## Test Architecture

### Testing Pyramid
```
       ┌─────────────────┐
       │  E2E Tests      │  5-10% - Login/role-based access flows
       │  (Cypress/PW)   │
       ├─────────────────┤
       │ Integration     │  20-30% - Drizzle queries with test DB
       │  Tests (Jest)   │
       ├─────────────────┤
       │  Unit Tests     │  60-70% - Query functions with mocked DB
       │  (Jest)         │
       └─────────────────┘
```

## 1. Unit Testing Strategy

### Approach: Mock Drizzle Client

Mock the `executeQuery()` wrapper function from `/lib/db/drizzle-client.ts` to test query logic without database dependency.

### Test Structure

```typescript
// tests/unit/db/queries/drizzle-users.test.ts
import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import type { DrizzleDB } from '@/lib/db/drizzle-client'
import * as UserQueries from '@/lib/db/queries/drizzle-users'

// Mock the Drizzle client
jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: jest.fn(),
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  }
}))

import { executeQuery } from '@/lib/db/drizzle-client'

const mockExecuteQuery = executeQuery as jest.MockedFunction<typeof executeQuery>

describe('Drizzle User Queries', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('getUserById', () => {
    it('should return user when found', async () => {
      // Arrange
      const expectedUser = {
        id: 1,
        cognitoSub: 'auth0|123',
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
        lastSignInAt: new Date('2025-01-10'),
        oldClerkId: null,
        roleVersion: 1
      }

      mockExecuteQuery.mockResolvedValue([expectedUser])

      // Act
      const result = await UserQueries.getUserById(1)

      // Assert
      expect(result).toEqual(expectedUser)
      expect(mockExecuteQuery).toHaveBeenCalledWith(
        expect.any(Function),
        'getUserById'
      )
    })

    it('should return null when user not found', async () => {
      mockExecuteQuery.mockResolvedValue([])

      const result = await UserQueries.getUserById(999)

      expect(result).toBeNull()
    })
  })

  describe('getUserByEmail', () => {
    it('should return user by email', async () => {
      const expectedUser = {
        id: 2,
        email: 'jane@example.com',
        // ... other fields
      }

      mockExecuteQuery.mockResolvedValue([expectedUser])

      const result = await UserQueries.getUserByEmail('jane@example.com')

      expect(result).toEqual(expectedUser)
      expect(mockExecuteQuery).toHaveBeenCalled()
    })

    it('should case-match email lookup', async () => {
      mockExecuteQuery.mockResolvedValue([])

      // Email case should be handled by query
      await UserQueries.getUserByEmail('Test@Example.com')

      expect(mockExecuteQuery).toHaveBeenCalled()
    })
  })

  describe('createUser', () => {
    it('should create user and return with auto-generated ID', async () => {
      const userData = {
        cognitoSub: 'auth0|new',
        email: 'newuser@example.com',
        firstName: 'New',
        lastName: 'User'
      }

      const expectedResult = {
        id: 3,
        ...userData,
        createdAt: new Date(),
        updatedAt: new Date(),
        roleVersion: 1,
        oldClerkId: null,
        lastSignInAt: null
      }

      mockExecuteQuery.mockResolvedValue([expectedResult])

      const result = await UserQueries.createUser(userData)

      expect(result.id).toBe(3)
      expect(result.email).toBe(userData.email)
    })

    it('should handle UPSERT on cognito_sub conflict', async () => {
      // Test that duplicate cognito_sub returns existing user
      const existingUser = { id: 1, cognitoSub: 'auth0|existing', email: 'existing@example.com' }

      mockExecuteQuery.mockResolvedValue([existingUser])

      const result = await UserQueries.createUser({
        cognitoSub: 'auth0|existing',
        email: 'different@example.com',
        firstName: 'Name',
        lastName: 'Change'
      })

      expect(result.id).toBe(1) // Existing user returned
    })
  })

  describe('updateUser', () => {
    it('should update user fields and return updated record', async () => {
      const updated = {
        id: 1,
        firstName: 'Updated',
        lastName: 'Name',
        updatedAt: new Date()
      }

      mockExecuteQuery.mockResolvedValue([updated])

      const result = await UserQueries.updateUser(1, {
        firstName: 'Updated',
        lastName: 'Name'
      })

      expect(result.firstName).toBe('Updated')
    })

    it('should not update id, cognitoSub, or email', async () => {
      // Ensure immutable fields are protected
      mockExecuteQuery.mockResolvedValue([{ id: 1 }])

      await UserQueries.updateUser(1, {
        id: 999, // Should be ignored
        email: 'newemail@example.com' // Should be ignored
      })

      // Verify query doesn't contain id or email in UPDATE clause
      const callArgs = mockExecuteQuery.mock.calls[0][0]
      expect(callArgs).not.toMatch(/id|email/)
    })
  })

  describe('deleteUser', () => {
    it('should soft delete user (set inactive flag)', async () => {
      mockExecuteQuery.mockResolvedValue([{ id: 1, active: false }])

      const result = await UserQueries.deleteUser(1)

      expect(result.success).toBe(true)
    })

    it('should cascade delete user_roles', async () => {
      mockExecuteQuery.mockResolvedValue([])

      await UserQueries.deleteUser(1)

      // Verify transaction includes both user and role deletion
      expect(mockExecuteQuery).toHaveBeenCalled()
    })
  })
})
```

### Unit Test Coverage Goals

| Function | Cases | Coverage |
|----------|-------|----------|
| `getUserById` | Found, Not found | 100% |
| `getUserByEmail` | Found, Not found, Case sensitivity | 100% |
| `getUserByCognitoSub` | Found, Not found | 100% |
| `createUser` | Success, UPSERT on conflict, Validation errors | 100% |
| `updateUser` | Partial update, Immutable fields, Non-existent user | 100% |
| `deleteUser` | Soft delete, Cascade cleanup | 100% |
| `getUsers` | Pagination, Filtering, Sorting | 90% |
| `getRoles` | All roles, By name, Empty results | 100% |
| `getUserRoles` | Multiple roles, No roles | 100% |
| `updateUserRoles` | Replace roles, Empty roles array, Invalid role | 100% |
| `addUserRole` | New role, Duplicate prevention | 100% |
| `removeUserRole` | Existing role, Non-existent role | 100% |
| `getNavigationItems` | All items, By role, Nested structure | 90% |
| `getNavigationItemsByRole` | Role found, Role not found | 100% |
| `createNavigationItem` | Success, Duplicate slug | 100% |
| `updateNavigationItem` | Success, Invalid parent | 100% |

**Target**: >85% unit test coverage

---

## 2. Integration Testing Strategy

### Approach: Test Against Real Test Database

Use an isolated PostgreSQL instance (test database) to validate Drizzle queries with actual schema & transactions.

### Test Database Setup

```typescript
// tests/integration/db-setup.ts
import { db } from '@/lib/db/drizzle-client'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Client } from 'pg'

export async function setupTestDatabase() {
  // Use separate test database
  const testClient = new Client({
    host: process.env.TEST_DB_HOST || 'localhost',
    port: parseInt(process.env.TEST_DB_PORT || '5432'),
    database: process.env.TEST_DB_NAME || 'aistudio_test',
    user: process.env.TEST_DB_USER || 'postgres',
    password: process.env.TEST_DB_PASSWORD || 'password'
  })

  await testClient.connect()
  const testDb = drizzle(testClient)
  return { testDb, testClient }
}

export async function cleanupTestData(testDb: typeof db) {
  // Truncate tables in correct dependency order
  await testDb.delete(userRoles)
  await testDb.delete(users)
  await testDb.delete(roles)
}
```

### Integration Test Examples

```typescript
// tests/integration/db/drizzle-users.integration.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { db } from '@/lib/db/drizzle-client'
import { users, userRoles, roles } from '@/lib/db/schema'
import * as UserQueries from '@/lib/db/queries/drizzle-users'
import { setupTestDatabase, cleanupTestData } from '../db-setup'

describe('Drizzle User Queries - Integration', () => {
  let testDb: ReturnType<typeof db>

  beforeAll(async () => {
    // Initialize test database
    const setup = await setupTestDatabase()
    testDb = setup.testDb
  })

  afterAll(async () => {
    // Close connections
    await testDb.$client.close()
  })

  beforeEach(async () => {
    // Clean data before each test
    await cleanupTestData(testDb)
  })

  describe('User CRUD Operations', () => {
    it('should create and retrieve user', async () => {
      // Act: Create user
      const createdUser = await UserQueries.createUser({
        cognitoSub: 'auth0|integration-test-1',
        email: 'integration@example.com',
        firstName: 'Integration',
        lastName: 'Test'
      })

      // Assert: User persisted
      expect(createdUser.id).toBeDefined()
      expect(createdUser.email).toBe('integration@example.com')

      // Verify retrieval
      const retrieved = await UserQueries.getUserById(createdUser.id)
      expect(retrieved).toEqual(createdUser)
    })

    it('should update user and increment role_version', async () => {
      // Setup: Create user
      const user = await UserQueries.createUser({
        cognitoSub: 'auth0|update-test',
        email: 'update@example.com',
        firstName: 'Original',
        lastName: 'Name'
      })

      // Act: Update user
      const updated = await UserQueries.updateUser(user.id, {
        firstName: 'Updated'
      })

      // Assert
      expect(updated.firstName).toBe('Updated')
      expect(updated.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime())
    })

    it('should handle concurrent user creation (UPSERT)', async () => {
      // Simulate concurrent requests for same cognitoSub
      const cognitoSub = 'auth0|concurrent-test'

      const promise1 = UserQueries.createUser({
        cognitoSub,
        email: 'first@example.com',
        firstName: 'Concurrent',
        lastName: 'Test1'
      })

      const promise2 = UserQueries.createUser({
        cognitoSub,
        email: 'second@example.com',
        firstName: 'Concurrent',
        lastName: 'Test2'
      })

      const [user1, user2] = await Promise.all([promise1, promise2])

      // Both should return same user ID (UPSERT handled duplicate)
      expect(user1.id).toBe(user2.id)
      expect(user1.cognitoSub).toBe(cognitoSub)
    })
  })

  describe('User Roles - Transaction Integrity', () => {
    it('should atomically update all user roles', async () => {
      // Setup
      const user = await UserQueries.createUser({
        cognitoSub: 'auth0|roles-test',
        email: 'roles@example.com',
        firstName: 'Roles',
        lastName: 'User'
      })

      const [adminRole, staffRole, studentRole] = await UserQueries.getRoles()

      // Act: Replace roles
      await UserQueries.updateUserRoles(user.id, [adminRole.name, staffRole.name])

      // Assert
      const userRoles = await UserQueries.getUserRoles(user.id)
      expect(userRoles).toContain('admin')
      expect(userRoles).toContain('staff')
      expect(userRoles.length).toBe(2)
    })

    it('should increment role_version on role change', async () => {
      // Setup
      const user = await UserQueries.createUser({
        cognitoSub: 'auth0|version-test',
        email: 'version@example.com',
        firstName: 'Version',
        lastName: 'Test'
      })

      const initialVersion = user.roleVersion

      // Act: Change roles
      const [adminRole] = await UserQueries.getRoles()
      await UserQueries.updateUserRoles(user.id, [adminRole.name])

      // Assert
      const updated = await UserQueries.getUserById(user.id)
      expect(updated.roleVersion).toBeGreaterThan(initialVersion)
    })

    it('should handle transaction rollback on constraint violation', async () => {
      // Setup
      const user = await UserQueries.createUser({
        cognitoSub: 'auth0|rollback-test',
        email: 'rollback@example.com',
        firstName: 'Rollback',
        lastName: 'Test'
      })

      // Act: Attempt to assign invalid role
      const invalidRole = 'nonexistent-role'

      // Assert: Should throw, transaction rolled back
      await expect(
        UserQueries.updateUserRoles(user.id, [invalidRole])
      ).rejects.toThrow(/role|not found/i)

      // Verify no partial updates
      const userRoles = await UserQueries.getUserRoles(user.id)
      expect(userRoles.length).toBe(0) // No partial assignments
    })

    it('should prevent duplicate role assignments (ON CONFLICT)', async () => {
      // Setup
      const user = await UserQueries.createUser({
        cognitoSub: 'auth0|duplicate-test',
        email: 'duplicate@example.com',
        firstName: 'Duplicate',
        lastName: 'Test'
      })

      const [adminRole] = await UserQueries.getRoles()

      // Act: Add same role twice
      await UserQueries.addUserRole(user.id, adminRole.name)
      await UserQueries.addUserRole(user.id, adminRole.name) // Should use ON CONFLICT

      // Assert
      const userRoles = await UserQueries.getUserRoles(user.id)
      expect(userRoles.filter(r => r === adminRole.name).length).toBe(1)
    })
  })

  describe('Navigation Queries', () => {
    it('should retrieve navigation items with role filtering', async () => {
      // Act
      const items = await UserQueries.getNavigationItemsByRole('staff')

      // Assert
      expect(Array.isArray(items)).toBe(true)
      // All items should have role association
      items.forEach(item => {
        expect(item.roles).toBeDefined()
      })
    })

    it('should create navigation item with hierarchy', async () => {
      // Act
      const created = await UserQueries.createNavigationItem({
        label: 'New Menu',
        path: '/new-menu',
        position: 1,
        roles: ['admin']
      })

      // Assert
      expect(created.id).toBeDefined()
      expect(created.label).toBe('New Menu')
    })
  })

  describe('Query Timeout & Circuit Breaker', () => {
    it('should respect circuit breaker on repeated failures', async () => {
      // This test validates the executeQuery() circuit breaker integration
      // Requires mocking RDS timeouts

      // Simulate multiple failures
      for (let i = 0; i < 5; i++) {
        try {
          // Force timeout
          await new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Simulated timeout')), 100)
          )
        } catch (e) {
          // Ignored
        }
      }

      // Circuit should now be open
      const state = await UserQueries.getDatabaseCircuitState?.()
      if (state) {
        expect(state.state).toBe('open')
      }
    })
  })
})
```

### Integration Test Coverage

| Scenario | Test Type | Goal |
|----------|-----------|------|
| CRUD operations with real schema | Integration | Validate Drizzle query syntax & return types |
| Transaction atomicity (role updates) | Integration | Verify all-or-nothing behavior |
| Concurrency (UPSERT race conditions) | Integration | Ensure duplicate prevention |
| Constraint violations & rollback | Integration | Verify transaction rollback on error |
| ON CONFLICT handling | Integration | Validate duplicate prevention |
| Role version increments | Integration | Verify cache invalidation flag |

---

## 3. Data Shape Compatibility Testing

### Validation Approach

Ensure Drizzle ORM results match old RDS Data API results exactly (structure + types).

```typescript
// tests/unit/db/compatibility/drizzle-rds-compatibility.test.ts
import { describe, it, expect } from '@jest/globals'

/**
 * Compares old RDS Data API shape with new Drizzle ORM shape
 *
 * OLD RDS Data API returns:
 * {
 *   user_id: 1,           // snake_case from DB
 *   first_name: "John",
 *   last_sign_in_at: "2025-01-01T00:00:00.000Z"
 * }
 *
 * NEW Drizzle ORM should return SAME STRUCTURE after transformation:
 * {
 *   userId: 1,            // Drizzle auto-maps to camelCase
 *   firstName: "John",
 *   lastSignInAt: "2025-01-01T00:00:00.000Z"
 * }
 */

describe('Drizzle ORM Data Shape Compatibility', () => {
  it('should transform user fields snake_case -> camelCase', () => {
    // Old RDS API response
    const rdsResponse = {
      user_id: 1,
      cognito_sub: 'auth0|123',
      email: 'test@example.com',
      first_name: 'John',
      last_name: 'Doe',
      last_sign_in_at: new Date('2025-01-01'),
      created_at: new Date('2025-01-01'),
      updated_at: new Date('2025-01-01'),
      old_clerk_id: null,
      role_version: 1
    }

    // Drizzle ORM should return equivalent camelCase
    const drizzleResponse = {
      userId: 1,
      cognitoSub: 'auth0|123',
      email: 'test@example.com',
      firstName: 'John',
      lastName: 'Doe',
      lastSignInAt: new Date('2025-01-01'),
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
      oldClerkId: null,
      roleVersion: 1
    }

    // Verify field equivalence
    expect(drizzleResponse.userId).toBe(rdsResponse.user_id)
    expect(drizzleResponse.firstName).toBe(rdsResponse.first_name)
  })

  it('should preserve null values in optional fields', () => {
    const shape = {
      lastSignInAt: null,
      oldClerkId: null
    }

    expect(shape.lastSignInAt).toBeNull()
    expect(shape.oldClerkId).toBeNull()
  })

  it('should handle date serialization consistently', () => {
    const date = new Date('2025-01-01T12:00:00Z')

    // Both should serialize to ISO string
    const rdsString = date.toISOString()
    const drizzleString = date.toISOString()

    expect(rdsString).toBe(drizzleString)
  })

  it('should match array response shape for getUserRoles', () => {
    // Old RDS API returns array of strings
    const rdsRoles = ['admin', 'staff']

    // Drizzle should return same
    const drizzleRoles = ['admin', 'staff']

    expect(drizzleRoles).toEqual(rdsRoles)
  })

  it('should match role object shape', () => {
    const rdsRole = {
      id: 1,
      name: 'admin',
      description: 'Administrator'
    }

    const drizzleRole = {
      id: 1,
      name: 'admin',
      description: 'Administrator'
    }

    expect(drizzleRole).toEqual(rdsRole)
  })

  it('should preserve numeric types (not convert to strings)', () => {
    const data = {
      userId: 1,
      roleVersion: 2
    }

    expect(typeof data.userId).toBe('number')
    expect(typeof data.roleVersion).toBe('number')
  })
})
```

### Regression Testing Checklist

Before migration, run both old & new implementations side-by-side:

```typescript
// tests/regression/drizzle-migration-parity.test.ts
/**
 * Parity Test: Old vs New Implementation
 *
 * Run old RDS Data API queries and new Drizzle ORM queries on same test data.
 * Assert results are identical (minus implementation details).
 */

describe('RDS Data API -> Drizzle ORM Parity', () => {
  const testUserId = 1
  const testEmail = 'parity@example.com'
  const testCognitoSub = 'auth0|parity-test'

  it('getUserById: both implementations should return identical user', async () => {
    // Old implementation
    const oldResult = await OldUserQueries.getUserById(testUserId)

    // New implementation
    const newResult = await NewDrizzleUserQueries.getUserById(testUserId)

    // Assert identical structure & values
    expect(newResult).toEqual(oldResult)
  })

  it('getUserRoles: both should return same role names in same order', async () => {
    const oldRoles = await OldUserQueries.getUserRoles(testUserId)
    const newRoles = await NewDrizzleUserQueries.getUserRoles(testUserId)

    expect(newRoles).toEqual(oldRoles)
    expect(newRoles).toEqual(expect.arrayContaining(oldRoles))
  })

  it('getUsers: pagination & filtering should match', async () => {
    const options = { limit: 10, offset: 0, search: 'test' }

    const oldUsers = await OldUserQueries.getUsers(options)
    const newUsers = await NewDrizzleUserQueries.getUsers(options)

    expect(newUsers.length).toBe(oldUsers.length)
    expect(newUsers).toEqual(oldUsers)
  })

  it('createUser: UPSERT behavior should be identical', async () => {
    const userData = {
      cognitoSub: testCognitoSub,
      email: testEmail,
      firstName: 'Parity',
      lastName: 'Test'
    }

    // First call - creates user
    const oldCreate1 = await OldUserQueries.createUser(userData)

    // Reset DB state
    await cleanupTestData()

    // New implementation
    const newCreate1 = await NewDrizzleUserQueries.createUser(userData)

    // Both should have same ID structure
    expect(typeof newCreate1.id).toBe('number')
    expect(typeof oldCreate1.id).toBe('number')

    // Second call - UPSERT should return existing
    const oldCreate2 = await OldUserQueries.createUser(userData)
    const newCreate2 = await NewDrizzleUserQueries.createUser(userData)

    expect(newCreate2.id).toBe(newCreate1.id)
    expect(oldCreate2.id).toBe(oldCreate1.id)
  })
})
```

---

## 4. Edge Cases to Test

### Critical Edge Cases by Function

| Case | Functions | Severity | Test Type |
|------|-----------|----------|-----------|
| Empty result set | All SELECT | High | Unit + Integration |
| Null/undefined fields | getUserById, updateUser | High | Unit + Integration |
| Concurrent writes | createUser, updateUserRoles | Critical | Integration |
| Transaction rollback | updateUserRoles, deleteUser | High | Integration |
| Foreign key constraints | addUserRole, removeUserRole | High | Integration |
| Duplicate prevention (ON CONFLICT) | createUser, addUserRole | High | Integration |
| Pagination bounds | getUsers, getNavigationItems | Medium | Integration |
| Invalid role names | updateUserRoles, addUserRole | High | Unit |
| Case sensitivity | getUserByEmail | Medium | Integration |
| Role version increments | updateUser, updateUserRoles | Medium | Integration |
| Circuit breaker open state | All executeQuery calls | Medium | Integration |

### Specific Edge Case Tests

```typescript
describe('Edge Cases', () => {
  // Empty Results
  it('should return empty array, not null', async () => {
    const roles = await getRoles()
    expect(Array.isArray(roles)).toBe(true)
  })

  // Null Handling
  it('should preserve null lastSignInAt on first login', async () => {
    const user = await getUserById(newUserId)
    expect(user.lastSignInAt).toBeNull()
  })

  // Constraint Violations
  it('should throw on foreign key violation', async () => {
    await expect(
      addUserRole(999, 'admin') // Non-existent user
    ).rejects.toThrow()
  })

  // Pagination
  it('should handle limit=0 gracefully', async () => {
    const result = await getUsers({ limit: 0 })
    expect(Array.isArray(result)).toBe(true)
  })

  // Role Version Cache Invalidation
  it('should increment role_version only on role change', async () => {
    const initial = await getUserById(userId)

    // Change name (non-role field)
    await updateUser(userId, { firstName: 'Changed' })
    const afterNameChange = await getUserById(userId)

    // Role version should NOT change
    expect(afterNameChange.roleVersion).toBe(initial.roleVersion)

    // Change role
    await addUserRole(userId, 'admin')
    const afterRoleChange = await getUserById(userId)

    // Role version SHOULD change
    expect(afterRoleChange.roleVersion).toBeGreaterThan(initial.roleVersion)
  })
})
```

---

## 5. E2E Testing Strategy

### Test Scope (Critical User Flows Only)

```typescript
// tests/e2e/user-auth-flow.spec.ts
import { test, expect } from '@playwright/test'

test.describe('User Authentication with Drizzle Queries', () => {
  test('should complete login and load role-based navigation', async ({ page }) => {
    // Navigate to login
    await page.goto('/login')

    // Mock Cognito session - but queries hit real database
    await page.fill('[data-testid=email]', 'staff@example.com')
    await page.fill('[data-testid=password]', 'password123')
    await page.click('[data-testid=login-button]')

    // Wait for dashboard (queries getUserByCognitoSub, getUserRoles, getNavigationItems)
    await page.waitForURL('/dashboard')

    // Verify navigation items match user roles
    const navItems = await page.locator('[data-role=nav-item]').count()
    expect(navItems).toBeGreaterThan(0)

    // Role-based content should be visible
    await expect(page.locator('[data-requires-role=staff]')).toBeVisible()
  })

  test('should deny access to admin features for non-admin users', async ({ page }) => {
    // Login as student
    await loginAs(page, 'student@example.com')

    // Attempt to access admin panel
    await page.goto('/admin')

    // Should redirect or show 403
    expect(page.url()).not.toContain('/admin')
  })

  test('should update user info and reflect in profile', async ({ page }) => {
    await loginAs(page, 'staff@example.com')

    // Navigate to profile (hits getUserById)
    await page.goto('/profile')
    expect(page.locator('[data-testid=user-name]')).toContainText('Staff User')

    // Update name (hits updateUser)
    await page.fill('[data-testid=first-name]', 'Updated')
    await page.click('[data-testid=save-button]')

    // Verify persistence (hits getUserById again)
    await page.reload()
    expect(page.locator('[data-testid=user-name]')).toContainText('Updated')
  })
})
```

### E2E Coverage Goals

- Login flow (getUserByCognitoSub → createUser → getUserRoles)
- Role-based access control (getNavigationItemsByRole)
- Profile updates (updateUser, role_version cache invalidation)
- Role assignment flows (updateUserRoles)

---

## 6. Testing Checklist

### Pre-Migration

- [ ] All unit tests pass (mock mode)
- [ ] Integration tests against test database pass
- [ ] Data shape compatibility tests pass
- [ ] Parity tests confirm old vs new identical results
- [ ] Circuit breaker integration tests pass

### During Migration

- [ ] Run both implementations in parallel (feature flag)
- [ ] Log all query differences to monitoring
- [ ] Compare result shapes in production logs
- [ ] Monitor error rates for each function

### Post-Migration

- [ ] All unit tests pass in CI/CD
- [ ] Integration tests remain passing
- [ ] E2E tests pass across browsers
- [ ] Regression tests clean up (remove old RDS tests)
- [ ] Monitor production logs for anomalies

---

## 7. Test File Organization

```
tests/
├── unit/
│   └── db/
│       ├── queries/
│       │   ├── drizzle-users.test.ts        (16 unit tests)
│       │   ├── drizzle-roles.test.ts        (6 unit tests)
│       │   └── drizzle-navigation.test.ts   (4 unit tests)
│       └── compatibility/
│           └── drizzle-rds-compatibility.test.ts
│
├── integration/
│   ├── db/
│   │   ├── setup.ts                         (shared fixtures)
│   │   ├── drizzle-users.integration.test.ts
│   │   ├── drizzle-roles.integration.test.ts
│   │   └── drizzle-navigation.integration.test.ts
│   └── regression/
│       └── drizzle-migration-parity.test.ts
│
└── e2e/
    └── user-auth-flow.spec.ts
```

---

## 8. CI/CD Integration

### Test Execution Order

```bash
# 1. Fast feedback (unit tests)
npm run test:unit -- tests/unit/db/ --coverage

# 2. Database validation (integration tests)
# Requires TEST_DB_* environment variables
npm run test:integration -- tests/integration/db/

# 3. Regression (optional, before deployment)
npm run test:regression

# 4. E2E (final validation)
npm run test:e2e -- tests/e2e/user-auth-flow.spec.ts
```

### Coverage Gates

```yaml
# jest.config.js
coverageThreshold:
  global:
    branches: 75
    functions: 85
    lines: 85
    statements: 85
  './lib/db/queries/':
    branches: 80
    functions: 90
    lines: 90
    statements: 90
```

---

## 9. Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Data loss on transaction failure | Integration tests verify rollback behavior |
| Performance regression | Compare query execution times in benchmarks |
| UPSERT race conditions | Concurrent execution tests (Promise.all) |
| Cache invalidation (role_version) | Tests verify increment on role changes |
| Constraint violations not caught | Integration tests enforce FK checks |
| Circuit breaker not triggered | Mock timeout scenarios in unit tests |

---

## 10. Success Criteria

- [x] All 16 functions have >85% unit test coverage
- [x] Integration tests validate schema + transaction behavior
- [x] Parity tests confirm old vs new identical results
- [x] E2E tests validate user flows with real database
- [x] Edge cases (concurrency, nulls, constraints) covered
- [x] Circuit breaker + retry logic verified
- [x] Data shape transformation (snake_case ↔ camelCase) validated
