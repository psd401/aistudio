# Drizzle Type Migration Guide

> Part of Epic #526 - RDS Data API to Drizzle ORM Migration
> Issue #530 - Type unification strategy

## Overview

This guide documents the migration from manual TypeScript type definitions in `/types/db-types.ts` to auto-generated Drizzle ORM types using `InferSelectModel` and `InferInsertModel`.

## Quick Reference

### Import Locations

| Location | Status | Description |
|----------|--------|-------------|
| `@/lib/db/types` | **Preferred** | Unified Drizzle-generated types |
| `@/lib/db/types/jsonb` | **Preferred** | JSONB interface definitions |
| `@/types/db-types` | Deprecated | Re-exports from `@/lib/db/types` |

### Migration Pattern

```typescript
// Before (deprecated)
import type { SelectUser, InsertUser } from '@/types/db-types';

// After (preferred)
import type { SelectUser, InsertUser } from '@/lib/db/types';

// For JSONB types
import type { NexusCapabilities } from '@/lib/db/types/jsonb';
```

## Type Mapping

### Core Tables

| Old Type | New Type | Notes |
|----------|----------|-------|
| `SelectUser` | `SelectUser` | Now includes `oldClerkId`, `roleVersion` |
| `InsertUser` | `InsertUser` | Same |
| `SelectTool` | `SelectTool` | Same |
| `InsertTool` | `InsertTool` | Same |
| `SelectNavigationItem` | `SelectNavigationItem` | Same |
| `InsertNavigationItem` | `InsertNavigationItem` | Same |

### AI Models

| Old Type | New Type | Breaking Changes |
|----------|----------|-----------------|
| `SelectAiModel` | `SelectAiModel` | `inputCostPer1kTokens` etc. now `string \| null` (was `number \| null`) |
| `InsertAiModel` | `InsertAiModel` | `allowedRoles` now `string[] \| null` (was `string \| null`) |

### JSONB Interfaces

All JSONB interfaces are unchanged and now exported from `@/lib/db/types/jsonb`:

- `NexusCapabilities`
- `ProviderMetadata`
- `ToolInputFieldOptions`
- `NexusConversationMetadata`
- `NexusFolderSettings`
- `NexusUserSettings`
- `NexusConversationEventData`
- `NexusMcpSchema`
- `NexusMcpAuditData`
- `NexusTemplateVariable`
- `ScheduleConfig`

## Breaking Type Changes

### 1. Numeric Fields

PostgreSQL `numeric` columns are represented as `string` in TypeScript to preserve decimal precision:

```typescript
// Old (incorrect)
inputCostPer1kTokens: number | null;

// New (correct - matches Drizzle)
inputCostPer1kTokens: string | null;
```

**Migration**: Use `parseFloat()` when numeric calculations are needed:

```typescript
const cost = model.inputCostPer1kTokens
  ? parseFloat(model.inputCostPer1kTokens)
  : 0;
```

### 2. JSONB Array Fields

Fields stored as JSONB arrays now have proper array typing:

```typescript
// Old (incorrect)
allowedRoles: string | null;

// New (correct)
allowedRoles: string[] | null;
```

### 3. New Schema Fields

Some tables have additional fields discovered during schema introspection:

- `users`: Added `oldClerkId`, `roleVersion`
- `documents`: Added `updatedAt`
- `document_chunks`: Added `updatedAt`, `embedding`, `pageNumber`

## snake_case Handling

### Drizzle Schema Pattern

Drizzle columns use camelCase properties mapped to snake_case column names:

```typescript
export const users = pgTable('users', {
  firstName: varchar('first_name', { length: 255 }),  // camelCase prop -> snake_case col
  lastSignInAt: timestamp('last_sign_in_at'),
});
```

### RDS Data API

When using raw RDS Data API queries (not Drizzle ORM), results return snake_case keys. Use the field mapper:

```typescript
import { transformSnakeToCamel } from '@/lib/db/field-mapper';

const rawResult = await executeSQL('SELECT first_name, user_id FROM users', []);
// { first_name: 'John', user_id: 123 }

const transformed = rawResult.map(row => transformSnakeToCamel<SelectUser>(row));
// { firstName: 'John', userId: 123 }
```

### Drizzle ORM

When using Drizzle ORM directly, column mapping is automatic:

```typescript
const user = await db.query.users.findFirst();
// { firstName: 'John', userId: 123 } - already camelCase
```

## Directory Structure

```
lib/db/
├── types/                 # Unified Drizzle types
│   ├── index.ts           # Main barrel export (all Select/Insert types)
│   └── jsonb/
│       └── index.ts       # JSONB interface definitions
├── schema/
│   ├── tables/            # Drizzle table definitions
│   └── index.ts           # Schema barrel export
└── field-mapper.ts        # snake_case -> camelCase utility

types/
└── db-types.ts            # DEPRECATED - re-exports from lib/db/types
```

## Migration Steps

### Step 1: Update Imports

Replace imports file by file:

```bash
# Find all files importing from @/types/db-types
grep -r "from '@/types/db-types'" --include="*.ts" --include="*.tsx" .
```

### Step 2: Fix Type Mismatches

Address breaking type changes as documented above.

### Step 3: Run Type Checks

```bash
npm run typecheck
```

### Step 4: Update Tests

Update test fixtures to match new type shapes.

## Consumer Count

As of Issue #530 implementation:

- **6 files** import from `@/types/db-types` in source code
- **10 schema files** use JSONB types (now from `@/lib/db/types/jsonb`)

## Known Type Mismatches

The following files have type errors that need to be addressed in follow-up work:

### Application Code

1. **`components/features/ai-models-table.tsx`**
   - Cost fields typed as `number | null` but schema uses `string | null`
   - `allowedRoles` typed as `string | null` but schema uses `string[] | null`

2. **`app/(protected)/utilities/assistant-architect/[id]/edit/input-fields/_components/input-fields-form.tsx`**
   - `ToolInputFieldOptions` usage needs review

### Test Files

1. **`tests/integration/s3-upload-api.test.ts`**
   - Mock user objects missing `oldClerkId`, `roleVersion`
   - Mock document objects missing `updatedAt`
   - Mock document chunks missing `updatedAt`, `embedding`, `pageNumber`

These are tracked in #552.

## Related Issues

- Epic: #526 - RDS Data API to Drizzle ORM Migration
- #528 - Generate Drizzle schema from live database
- #529 - Create Drizzle database client wrapper
- #530 - Type unification strategy (this issue)
- #552 - Fix type mismatches in consuming code
