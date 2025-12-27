# Drizzle ORM Migration Status

**Epic**: #526 - RDS Data API to Drizzle ORM Migration
**Issue**: #541 - Remove Legacy RDS Data API Code
**Branch**: `feature/541-remove-legacy-rds-partial`
**Last Updated**: 2025-12-26

## Overview

This document tracks the progress of migrating from AWS RDS Data API (`executeSQL`) to Drizzle ORM across the AI Studio codebase.

## ✅ Completed Migrations

### Actions Layer
- ✅ **actions/db/assistant-architect-actions.ts** (28 functions, ~87 executeSQL calls eliminated)
  - All CRUD operations for assistant architects
  - Input field management
  - Chain prompt operations
  - Approval workflow
  - Tool execution tracking
  - Committed across 9 detailed commits

- ✅ **actions/admin/moderate-prompt.actions.ts**
  - Moderation queue operations
  - Bulk moderation
  - Statistics retrieval

### Drizzle Modules Created
- ✅ **lib/db/drizzle/ideas.ts** - Ideas, votes, and notes operations
- ✅ **lib/db/drizzle/notifications.ts** - User notification operations
- ✅ **lib/db/drizzle/execution-results.ts** - Tool execution results
- ✅ **lib/db/drizzle/settings.ts** - Application settings operations

### API Routes
- ✅ **app/api/admin/assistants/route.ts** - Admin assistant management
- ✅ **app/api/admin/assistants/[id]/route.ts** - Single assistant operations

### Utilities
- ✅ **lib/logging-helpers.ts** - Role checking in logging wrapper

### Schema & Infrastructure
- ✅ All table schemas defined in Drizzle
- ✅ Enum types migrated
- ✅ Relations defined
- ✅ Migration generation workflow established

## 🚧 Remaining Work

### Files with executeSQL Usage (11 files)

#### High Priority - API Routes (4 files)
1. **app/api/nexus/chat/route.ts** - Main chat endpoint
   - Uses: `executeSQL` for chat history/operations
   - Complexity: HIGH (7 occurrences)
   - Impact: HIGH (main user-facing feature)

2. **app/api/assistant-architect/execute/route.ts** - Tool execution
   - Uses: `executeSQL`, `checkUserRoleByCognitoSub`
   - Complexity: MEDIUM (8 occurrences)
   - Impact: HIGH (critical feature)

3. **app/api/assistant-architect/execute/scheduled/route.ts** - Scheduled execution
   - Uses: `executeSQL`
   - Complexity: HIGH (14 occurrences)
   - Impact: MEDIUM

4. **app/api/compare/route.ts** - Model comparison
   - Uses: `executeSQL`
   - Complexity: LOW (5 occurrences)
   - Impact: MEDIUM

#### Medium Priority - Library Functions (4 files)
5. **lib/streaming/nexus/db-helpers.ts** - Nexus chat DB operations
   - Uses: `executeSQL`, `executeTransaction`
   - Complexity: MEDIUM (5 occurrences)
   - Impact: HIGH (chat functionality)
   - Note: Uses executeTransaction which needs careful migration

6. **lib/prompt-library/access-control.ts** - Prompt permission checks
   - Uses: `executeSQL`
   - Complexity: LOW (5 occurrences)
   - Impact: MEDIUM

7. **lib/repositories/search-service.ts** - Vector/hybrid search
   - Uses: `executeSQL`
   - Complexity: MEDIUM (4 occurrences)
   - Impact: HIGH (knowledge retrieval)

8. **lib/assistant-export-import.ts** - Tool import/export
   - Uses: `executeSQL`
   - Complexity: LOW (5 occurrences)
   - Impact: LOW

#### Low Priority - Query Helpers (3 files)
9. **lib/db/queries/documents.ts** - Document query helpers
   - Uses: `executeSQL`, `FormattedRow`
   - Complexity: MEDIUM (11 occurrences)
   - Impact: MEDIUM
   - Note: Consider migrating to lib/db/drizzle/documents.ts

10. **lib/db/queries/assistant-architect.ts** - Assistant query helpers
    - Uses: `executeSQL`
    - Complexity: MEDIUM (9 occurrences)
    - Impact: LOW (may be redundant with drizzle/assistant-architects.ts)

11. **lib/assistant-architect/knowledge-retrieval.ts** - Knowledge base queries
    - Uses: `executeSQL`
    - Complexity: LOW (2 occurrences)
    - Impact: MEDIUM

### Legacy Files to Remove

Once all migrations are complete, these files can be deleted:
- `lib/db/data-api-adapter.ts` (1,141 lines)
- `lib/db/field-mapper.ts` (if no longer used)
- `lib/db/connection-manager.ts` (if RDS Data API specific)

## 📊 Migration Statistics

### Overall Progress
- **Files Migrated**: 10+ files fully migrated
- **executeSQL Calls Eliminated**: ~150+ calls
- **Files Remaining**: 11 files
- **Estimated Remaining executeSQL**: ~80 calls

### Complexity Breakdown
- **High Complexity**: 3 files (scheduled execution, nexus chat, documents)
- **Medium Complexity**: 5 files (tool execution, repositories, etc.)
- **Low Complexity**: 3 files (comparison, export-import, knowledge retrieval)

## 🎯 Recommended Next Steps

### Phase 1: Critical Features (Week 1)
1. Migrate `lib/streaming/nexus/db-helpers.ts`
   - Most complex due to executeTransaction
   - Critical for chat functionality
   - Create `lib/db/drizzle/nexus-helpers.ts` if needed

2. Migrate `app/api/nexus/chat/route.ts`
   - Main user-facing chat endpoint
   - Depends on nexus db-helpers

3. Migrate `app/api/assistant-architect/execute/route.ts`
   - Critical tool execution path

### Phase 2: Supporting Features (Week 2)
4. Migrate `lib/repositories/search-service.ts`
   - Important for knowledge base functionality

5. Migrate `lib/prompt-library/access-control.ts`
   - Important for permissions

6. Migrate `app/api/compare/route.ts`
   - Standalone, lower impact

### Phase 3: Cleanup (Week 3)
7. Migrate remaining query helper files
8. Consolidate or remove duplicate functionality
9. Delete legacy data-api-adapter.ts
10. Update all test files
11. Run full integration test suite

## 🔍 Migration Patterns Established

### Authorization Pattern
```typescript
// OLD
const isAdmin = await checkUserRoleByCognitoSub(session.sub, "administrator")

// NEW
const isAdmin = await hasRole("administrator")
```

### User ID Retrieval Pattern
```typescript
// OLD
const userId = await getCurrentUserId()

// NEW
const currentUserResult = await getCurrentUserAction()
const userId = currentUserResult.data.user.id
```

### Query Pattern
```typescript
// OLD
const result = await executeSQL(`SELECT * FROM table WHERE id = :id`, params)
const data = transformSnakeToCamel(result[0])

// NEW
const [data] = await executeQuery(
  (db) => db.select().from(table).where(eq(table.id, id)).limit(1),
  "operationName"
)
```

### Insert with Returning Pattern
```typescript
// OLD
const result = await executeSQL(`INSERT INTO table (...) RETURNING id`, params)
const id = result[0].id

// NEW
const [record] = await executeQuery(
  (db) => db.insert(table).values(data).returning(),
  "operationName"
)
const id = record.id
```

## ⚠️ Known Issues & Gotchas

1. **Field Type Mapping**: UI field types (text, textarea, etc.) must be mapped to DB enum (short_text, long_text, etc.)

2. **promptResults Schema**: Uses `outputData`, `errorMessage`, `executionTimeMs` (not `result`, `error`, `executionTime`)

3. **Navigation Items**: Auto-increment IDs, don't insert strings into integer columns

4. **Transaction Complexity**: `executeTransaction` from data-api-adapter needs careful migration to Drizzle transactions

5. **Type Safety**: Drizzle returns typed objects directly, no need for `transformSnakeToCamel`

## 📝 Notes

- All migrations pass TypeScript strict mode checks
- No `any` types introduced
- Comprehensive commit messages document all changes
- Circuit breaker pattern maintained via `executeQuery` wrapper
- Error handling preserved and enhanced

## 🔗 Related Documentation

- [Drizzle ORM Guide](./docs/database/drizzle-migration-guide.md)
- [Drizzle Documentation](./docs/database/drizzle-documentation.md)
- [Epic #526](https://github.com/psd401/aistudio/issues/526)
- [Issue #541](https://github.com/psd401/aistudio/issues/541)
