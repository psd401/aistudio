# Issue #531 Test Strategy - Executive Summary

## Document Location
`/docs/testing/issue-531-test-strategy.md`

## Quick Reference

### Testing Approach (3 Tiers)

| Tier | Scope | Tool | Mock Strategy | Expected Coverage |
|------|-------|------|---------------|-------------------|
| **Unit** | Query logic | Jest | Mock `executeQuery()` | 85%+ (16 functions) |
| **Integration** | Schema + transactions | Jest + Test DB | Real schema validation | 80%+ (concurrency, rollback) |
| **E2E** | User flows | Playwright | Real DB | Login, roles, profile updates |

### Mocking Strategy

**Unit tests mock the Drizzle abstraction layer**:
```typescript
jest.mock('@/lib/db/drizzle-client', () => ({
  executeQuery: jest.fn()  // Mock wrapper function only
}))
```

This approach:
- Tests query logic without DB dependency
- Validates data shape transformations (snake_case → camelCase)
- Runs fast (~100ms per test)
- Does NOT test Drizzle ORM behavior (covered by integration tests)

### Key Edge Cases to Test

1. **Empty results** - All SELECT queries must return arrays (not null)
2. **Null fields** - Preserve nulls in optional columns (lastSignInAt, oldClerkId)
3. **Concurrent writes** - UPSERT on cognitoSub prevents race conditions
4. **Transaction rollback** - Role updates must atomically succeed or fail
5. **Constraint violations** - FK violations on invalid role assignments
6. **ON CONFLICT clauses** - Duplicate role assignments prevented
7. **Role version increments** - Cache invalidation flag updated only on role change
8. **Circuit breaker** - Open state when DB unavailable (retries exhausted)

### Data Shape Validation

**Old RDS Data API → New Drizzle ORM**

Must match field names after transformation:
- `user_id` → `userId`
- `cognito_sub` → `cognitoSub`
- `created_at` → `createdAt`
- Date types remain ISO strings
- Numeric types remain numbers (not strings)
- Null values preserved

### 16 Functions to Test

**User Operations** (6 functions)
- `getUserById()` - Single user by ID
- `getUserByEmail()` - Single user by email
- `getUserByCognitoSub()` - Single user by Cognito ID
- `createUser()` - UPSERT on cognitoSub
- `updateUser()` - Partial field updates
- `deleteUser()` - Soft delete with cascade

**Role Management** (5 functions)
- `getRoles()` - All available roles
- `getUserRoles()` - Roles for specific user
- `updateUserRoles()` - Replace all user roles (atomic transaction)
- `addUserRole()` - Add single role (ON CONFLICT do nothing)
- `removeUserRole()` - Remove single role

**Navigation Items** (5 functions)
- `getNavigationItems()` - All nav items (with pagination)
- `getNavigationItemsByRole()` - Nav items for user's roles
- `createNavigationItem()` - New nav item
- `updateNavigationItem()` - Modify nav item

### Test File Organization

```
tests/
├── unit/db/
│   ├── queries/
│   │   ├── drizzle-users.test.ts         (10+ tests per function)
│   │   ├── drizzle-roles.test.ts
│   │   └── drizzle-navigation.test.ts
│   └── compatibility/
│       └── drizzle-rds-compatibility.test.ts  (Field mapping validation)
│
├── integration/db/
│   ├── setup.ts                           (Test DB fixtures)
│   ├── drizzle-users.integration.test.ts   (CRUD, UPSERT, concurrency)
│   ├── drizzle-roles.integration.test.ts   (Transaction integrity)
│   └── drizzle-navigation.integration.test.ts
│
└── e2e/
    └── user-auth-flow.spec.ts             (Login → roles → profile)
```

### Integration Test Database Setup

Requires separate test PostgreSQL instance:
```bash
TEST_DB_HOST=localhost
TEST_DB_PORT=5432
TEST_DB_NAME=aistudio_test
TEST_DB_USER=postgres
TEST_DB_PASSWORD=password
```

Tests:
- Create/truncate tables before/after each test
- Validate schema constraints (FK, unique, NOT NULL)
- Test transaction rollback on errors
- Verify concurrent UPSERT behavior

### Pre-Migration Checklist

- [ ] Unit tests mocking `executeQuery()` pass
- [ ] Integration tests with test DB pass
- [ ] Parity tests (old vs new) produce identical results
- [ ] Data shape compatibility tests pass
- [ ] Edge cases (concurrency, nulls, constraints) covered

### Risk Mitigation

| Risk | How to Test |
|------|-------------|
| Race condition on concurrent createUser | Promise.all() in integration tests |
| Transaction partial updates on FK violation | Mock constraint errors in integration |
| UPSERT duplicates not prevented | ON CONFLICT integration tests |
| Cache invalidation skipped | Verify role_version increments on role change |
| Circuit breaker not opening | Mock repeated RDS failures |

### Success Criteria

✓ 85%+ unit test coverage for all 16 functions
✓ Integration tests validate transactions + concurrency
✓ Parity tests confirm old vs new identical results
✓ E2E tests validate user flows (login → roles → profile)
✓ All edge cases covered (nulls, empty results, constraints)
✓ Data shape compatibility verified

---

## Implementation Notes

### Unit Tests (Fast, Parallel)
- Mock `executeQuery()` to control return values
- Test happy paths, error paths, edge cases
- Validate data transformation logic
- Run in ~100ms per test

### Integration Tests (Slower, Sequential)
- Use real PostgreSQL test instance
- Validate Drizzle ORM syntax against actual schema
- Test multi-step transactions (UPSERT, cascade)
- Verify constraint enforcement
- Run in ~1-2s per test

### E2E Tests (Slowest, Visual)
- Real application → real database
- Validate complete user flows
- Ensure UI reflects DB state correctly
- Run once before deployment

### Regression Testing
Run old RDS Data API implementation alongside new Drizzle ORM:
```typescript
const oldResult = await OldUserQueries.getUserById(1)
const newResult = await NewDrizzleUserQueries.getUserById(1)
expect(newResult).toEqual(oldResult)
```

This ensures behavior compatibility before replacing old code.
