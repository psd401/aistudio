# Drizzle Migration Guide

Comprehensive guide for creating and managing database migrations with Drizzle ORM.

**Part of Epic #526** - RDS Data API to Drizzle ORM Migration

## Table of Contents

1. [Overview](#overview)
2. [Migration Workflow](#migration-workflow)
3. [Creating New Tables](#creating-new-tables)
4. [Modifying Existing Tables](#modifying-existing-tables)
5. [Creating Indexes](#creating-indexes)
6. [JSONB Columns](#jsonb-columns)
7. [Lambda Integration](#lambda-integration)
8. [Testing Migrations](#testing-migrations)
9. [Rollback Procedures](#rollback-procedures)

---

## Overview

The migration system uses a hybrid approach:

| Component | Location | Purpose |
|-----------|----------|---------|
| Drizzle Schema | `/lib/db/schema/` | TypeScript source of truth |
| SQL Migrations | `/infra/database/schema/` | Executed by Lambda during CDK deploy |
| Migration Helper Scripts | `/scripts/drizzle-helpers/` | Automation tools |

### Migration Numbering

- **001-009**: IMMUTABLE initial schema (never modify)
- **010+**: Additive migrations (new tables, columns, indexes)
- Gaps are allowed (021, 023, 024 is valid)

---

## Migration Workflow

```
┌─────────────────────────┐
│  Update Drizzle Schema  │
│  (lib/db/schema/)       │
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│  npm run drizzle:generate│
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│  npm run migration:prepare│
│  (validates + formats)   │
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│  Add to MIGRATION_FILES  │
│  (db-init-handler.ts)    │
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│  Deploy via CDK          │
│  (Lambda executes SQL)   │
└─────────────────────────┘
```

### Quick Commands

```bash
# List all migrations
npm run migration:list

# Generate from schema changes
npm run drizzle:generate

# Prepare for Lambda
npm run migration:prepare -- "description"

# Create empty migration
npm run migration:create -- "description"
```

---

## Creating New Tables

### Primary Key: Identity vs Serial

**2025 Best Practice:** Use `identity` columns for new tables instead of `serial`.

```typescript
// ✅ Recommended (2025+): Identity columns
import { integer } from "drizzle-orm/pg-core";

export const newTable = pgTable("new_table", {
  id: integer("id").generatedAlwaysAsIdentity({
    startWith: 1,
    increment: 1,
    minValue: 1,
    maxValue: 2147483647,
    cache: 1,
  }).primaryKey(),
});

// ⚠️ Legacy (still works): Serial columns
import { serial } from "drizzle-orm/pg-core";

export const legacyTable = pgTable("legacy_table", {
  id: serial("id").primaryKey(),
});
```

**Why identity?**
- SQL standard compliance (vs PostgreSQL-specific serial)
- More control over sequence behavior
- Explicit configuration options
- Recommended by PostgreSQL 10+

**Note:** Existing tables using `serial` work fine - only use `identity` for NEW tables.

### Step 1: Define the Schema

Create a new file in `lib/db/schema/tables/`:

```typescript
// lib/db/schema/tables/user-preferences.ts
import {
  pgTable,
  integer,
  varchar,
  timestamp,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { users } from "./users";

// Define JSONB type for type safety
interface PreferenceSettings {
  theme: "light" | "dark" | "system";
  notifications: boolean;
  language: string;
}

export const userPreferences = pgTable("user_preferences", {
  // Use identity for new tables (2025+ best practice)
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  theme: varchar("theme", { length: 20 }).default("system"),
  settings: jsonb("settings").$type<PreferenceSettings>(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
```

### Step 2: Export from Schema Index

```typescript
// lib/db/schema/index.ts
export * from "./tables/user-preferences";
```

### Step 3: Generate Migration

```bash
npm run drizzle:generate
```

### Step 4: Prepare for Lambda

```bash
npm run migration:prepare -- "add-user-preferences-table"
```

This creates `043-add-user-preferences-table.sql` in `/infra/database/schema/`.

### Step 5: Register Migration

Edit `/infra/database/lambda/db-init-handler.ts`:

```typescript
const MIGRATION_FILES = [
  // ... existing migrations ...
  '042-previous-migration.sql',
  '043-add-user-preferences-table.sql',  // Add here
];
```

### Step 6: Deploy

```bash
cd infra && npx cdk deploy AIStudio-DatabaseStack-Dev
```

---

## Modifying Existing Tables

### Adding Columns

```typescript
// Update the table definition
export const users = pgTable("users", {
  // ... existing columns ...
  displayName: varchar("display_name", { length: 100 }),  // NEW
  avatarUrl: varchar("avatar_url", { length: 500 }),       // NEW
});
```

Then generate and prepare the migration as normal.

### Renaming Columns

**Warning**: Drizzle-kit may generate a DROP + ADD instead of RENAME. Always review!

```sql
-- Manual migration recommended
ALTER TABLE users RENAME COLUMN old_name TO new_name;
```

### Changing Column Types

Create a manual migration:

```bash
npm run migration:create -- "change-column-type"
```

Then edit the SQL file:

```sql
-- Safely change varchar length
ALTER TABLE users ALTER COLUMN email TYPE VARCHAR(500);

-- Change with data conversion
ALTER TABLE users ALTER COLUMN status TYPE INTEGER USING status::integer;
```

---

## Creating Indexes

### In Schema

```typescript
import { pgTable, index, uniqueIndex } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  // columns...
}, (table) => ({
  // Regular index
  emailIdx: index("users_email_idx").on(table.email),

  // Unique index
  cognitoSubUnique: uniqueIndex("users_cognito_sub_unique").on(table.cognitoSub),

  // Composite index
  nameIdx: index("users_name_idx").on(table.firstName, table.lastName),
}));
```

### Manual Index Migration

```sql
-- Use IF NOT EXISTS for idempotency
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Partial index
CREATE INDEX IF NOT EXISTS idx_active_users
ON users (email) WHERE is_active = true;
```

**Note**: `CONCURRENTLY` is NOT supported by RDS Data API.

---

## JSONB Columns

### Type-Safe JSONB

Define types in `/lib/db/types/jsonb/index.ts`:

```typescript
export interface UserSettings {
  theme: "light" | "dark" | "system";
  notifications: {
    email: boolean;
    push: boolean;
  };
  language: string;
}
```

Use in schema:

```typescript
import type { UserSettings } from "@/lib/db/types/jsonb";

export const userPreferences = pgTable("user_preferences", {
  settings: jsonb("settings").$type<UserSettings>(),
});
```

### Querying JSONB

```typescript
import { sql } from "drizzle-orm";

// Access nested field
const results = await db
  .select()
  .from(userPreferences)
  .where(sql`${userPreferences.settings}->>'theme' = 'dark'`);

// Check if key exists
const hasNotifications = await db
  .select()
  .from(userPreferences)
  .where(sql`${userPreferences.settings} ? 'notifications'`);
```

---

## Lambda Integration

### How It Works

1. CDK deploys the DatabaseStack
2. Custom Resource triggers Lambda function
3. Lambda reads `MIGRATION_FILES` array
4. Executes each SQL file in order
5. Records in `migration_log` table

### Migration Log

```sql
SELECT * FROM migration_log ORDER BY executed_at DESC;
```

| Column | Description |
|--------|-------------|
| step_number | Sequential execution order |
| description | Migration filename |
| status | 'completed' or 'failed' |
| executed_at | Timestamp |
| error_message | Error details if failed |

### RDS Data API Constraints

**Not Supported:**

```sql
-- CONCURRENTLY (requires autocommit)
CREATE INDEX CONCURRENTLY idx_name ON table (col);

-- Dollar-quoted DO blocks
DO $$
BEGIN
  -- code
END $$;

-- Transaction control (Lambda manages this)
BEGIN;
COMMIT;
ROLLBACK;
```

**Supported:**

```sql
-- Idempotent operations
CREATE TABLE IF NOT EXISTS ...
CREATE INDEX IF NOT EXISTS ...
ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...
DROP TABLE IF EXISTS ...
```

---

## Testing Migrations

### Local Validation

```bash
# List migrations and verify files exist
npm run migration:list

# Check SQL syntax (requires psql)
psql -h localhost -U postgres -d test -f migration.sql --dry-run
```

### Dev Environment Testing

```bash
# Deploy to dev
cd infra && npx cdk deploy AIStudio-DatabaseStack-Dev

# Verify via MCP tools
# Use: mcp__awslabs_postgres-mcp-server__get_table_schema

# Check migration log
# Use: mcp__awslabs_postgres-mcp-server__run_query
# SQL: SELECT * FROM migration_log WHERE description = '043-...'
```

### Verify Schema Sync

```typescript
// Compare Drizzle schema with live database
import { db } from "@/lib/db/drizzle-client";
import { users } from "@/lib/db/schema";

// This will throw if schema doesn't match
const result = await db.select().from(users).limit(1);
```

---

## Rollback Procedures

### Manual Rollback Steps

1. **Connect to database:**
   ```bash
   psql -h <rds-endpoint> -U <username> -d aistudio
   ```

2. **Run rollback SQL:**
   ```sql
   -- Example: Drop newly added table
   DROP TABLE IF EXISTS user_preferences;
   ```

3. **Remove from migration_log:**
   ```sql
   DELETE FROM migration_log
   WHERE description = '043-add-user-preferences-table.sql';
   ```

4. **Remove from MIGRATION_FILES:**
   Edit `db-init-handler.ts` and remove the entry.

5. **Redeploy:**
   ```bash
   cd infra && npx cdk deploy AIStudio-DatabaseStack-Dev
   ```

### Adding Rollback SQL to Migrations

Always include rollback SQL in comments:

```sql
-- Migration 043: Add user preferences table
-- Created: 2025-01-15

CREATE TABLE IF NOT EXISTS user_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  theme VARCHAR(20) DEFAULT 'system',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- ============================================
-- ROLLBACK SQL (for manual rollback if needed)
-- ============================================
-- DROP TABLE IF EXISTS user_preferences;
```

---

## Best Practices

1. **One change per migration** - Keep migrations focused
2. **Use IF NOT EXISTS/IF EXISTS** - Makes migrations idempotent
3. **Test in dev first** - Never deploy untested migrations to prod
4. **Review generated SQL** - Drizzle-kit output may need adjustments
5. **Keep schema and SQL in sync** - Update both when making changes
6. **Document rollback SQL** - Include in migration file comments
7. **Use transactions for multi-step** - Lambda wraps in transaction automatically

---

## Related Documentation

- [Drizzle Query Patterns](./drizzle-patterns.md)
- [Drizzle Troubleshooting](./drizzle-troubleshooting.md)
- [Migration History](./migration-history.md)

---

*Last Updated: 2025-01-15*
*Part of Epic #526 - RDS Data API to Drizzle ORM Migration*
