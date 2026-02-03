# Drizzle Migration Testing Index - Issue #531

Quick navigation for test strategy documentation.

## Documents

### 1. Main Test Strategy
**File**: `/docs/testing/issue-531-test-strategy.md` (981 lines, 29KB)

Comprehensive test strategy covering:
- Testing pyramid (unit/integration/E2E)
- Unit testing approach with mocked Drizzle client
- Integration testing with test database
- Data shape compatibility testing
- Edge cases and risk mitigation
- CI/CD pipeline configuration
- Success criteria

**Key sections**:
- Section 1: Unit Testing Strategy (mock executeQuery)
- Section 2: Integration Testing Strategy (test DB setup)
- Section 3: Data Shape Compatibility Testing (field mapping validation)
- Section 4: Edge Cases (16 cases by severity)
- Section 5: E2E Testing Strategy (critical user flows)
- Section 6-10: Implementation details, CI/CD, checklists

### 2. Executive Summary
**File**: `/docs/testing/ISSUE-531-SUMMARY.md` (174 lines, 5.8KB)

Quick reference with:
- 3-tier testing approach at a glance
- Mocking strategy explanation
- 16 edge cases to test (table format)
- Data shape validation mapping
- 16 functions breakdown by category
- Test file organization
- Integration test DB setup
- Pre-migration checklist
- Risk mitigation table

**Use this for**: Quick onboarding, team alignment, implementation kickoff

### 3. Reusable Test Templates
**File**: `/docs/testing/drizzle-migration-test-templates.md` (437 lines, 10KB)

Copy-paste templates for:
- Unit test structure with Jest mocks
- Integration test setup with test DB
- Data shape compatibility tests
- E2E test patterns with Playwright
- Mocking patterns (success, error, multiple calls)
- Assertion patterns (verify calls, data shape, arrays)
- Test data fixtures
- Environment variables
- Docker Compose for test database
- CI/CD workflow configuration

**Use this for**: Starting new test files, consistent patterns across team

---

## How to Use These Documents

### Phase 1: Planning
1. Read **ISSUE-531-SUMMARY.md** (5 min)
   - Understand 3-tier approach
   - Review 16 functions to test
   - Check pre-migration checklist

2. Review main strategy sections 1-4 (15 min)
   - Unit testing approach
   - Integration test database setup
   - Edge cases you'll encounter

### Phase 2: Implementation
1. Use **drizzle-migration-test-templates.md** as reference
   - Copy unit test template
   - Copy integration test setup
   - Adapt for each function

2. Reference main strategy section for:
   - Specific edge cases (Section 4)
   - Data compatibility expectations (Section 3)
   - Mocking patterns from existing tests

### Phase 3: Testing
1. Follow testing checklist from main strategy (Section 6)
2. Monitor coverage thresholds from strategy (85%+ goal)
3. Verify edge cases covered (Section 4 table)

### Phase 4: Migration
1. Use parity testing approach from strategy (Section 3)
2. Follow CI/CD configuration (Section 8)
3. Check risk mitigation table (Section 9)

---

## Key Takeaways

### Mocking Strategy
- Mock `executeQuery()` in unit tests
- This tests query logic without DB dependency
- DO NOT mock Drizzle ORM itself
- Integration tests use real DB

### Coverage Goals
- **Unit tests**: 85%+ coverage, <100ms per test
- **Integration tests**: Real DB validation, 1-2s per test
- **E2E tests**: Login, roles, profile update flows only

### 16 Functions to Test
| Category | Count | Examples |
|----------|-------|----------|
| User Operations | 6 | getUserById, createUser, updateUser |
| Role Management | 5 | getUserRoles, updateUserRoles, addUserRole |
| Navigation | 5 | getNavigationItems, getNavigationItemsByRole |

### Edge Cases
**Critical** (must test):
- Empty result sets
- Concurrent writes (UPSERT)
- Transaction rollback
- Foreign key constraints

**Important** (should test):
- Null field handling
- ON CONFLICT duplicate prevention
- Role version increments
- Circuit breaker state

### Data Shape Validation
Results must match field names after transformation:
```
RDS Data API          →    Drizzle ORM
user_id               →    userId
cognito_sub           →    cognitoSub
created_at            →    createdAt
```

### Test Database
Required for integration tests:
```
postgres://postgres:password@localhost:5432/aistudio_test
```

Set environment variables:
```bash
TEST_DB_HOST=localhost
TEST_DB_PORT=5432
TEST_DB_NAME=aistudio_test
TEST_DB_USER=postgres
TEST_DB_PASSWORD=password
```

---

## References to Existing Code

### Existing Patterns to Follow
- Unit test example: `/tests/unit/actions/user-creation-upsert.test.ts`
- Integration test example: `/tests/integration/s3-upload-api.test.ts`
- Logger usage: `/lib/logger.ts`
- Drizzle client: `/lib/db/drizzle-client.ts`
- Existing user roles: `/lib/db/user-roles.ts` (RDS Data API version)

### Codebase Configuration
- Jest config: Strict TypeScript, no `any` types
- Test environment: Node.js (for unit/integration)
- Playwright: E2E only
- Coverage gates: 75% branches, 85% functions/lines

---

## Quick Reference: Test File Structure

```
tests/unit/db/queries/drizzle-users.test.ts
├── Mock setup (executeQuery)
├── Test describe block per function
│   ├── Happy path test
│   ├── Error cases
│   └── Edge cases
└── Assertions on mock calls + results

tests/integration/db/drizzle-users.integration.test.ts
├── Test database setup
├── Cleanup between tests
├── Describe block per function
│   ├── CRUD operations
│   ├── Transaction behavior
│   └── Concurrency tests
└── Assertions on actual DB data

tests/e2e/user-auth-flow.spec.ts
├── Login flow (getUserByCognitoSub)
├── Navigation items (getNavigationItemsByRole)
└── Profile update (updateUser)
```

---

## Unresolved Questions (Pre-Implementation)

1. Will test database be provisioned in CI/CD? (Currently assumes Docker Postgres)
2. Should parity tests run against both RDS and Drizzle simultaneously or sequentially?
3. Performance benchmark targets for query execution?
4. Circuit breaker failure injection method (mock or real timeout)?
5. Should role_version increment be validated in every role change test or sampled?

---

**Last Updated**: December 19, 2025
**Issue**: #531 - Migrate User & Authorization queries to Drizzle ORM
**Status**: Ready for implementation planning
