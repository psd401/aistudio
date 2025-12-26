# Database Migrations with Drizzle-Kit

This document describes the hybrid migration workflow that uses Drizzle schema as source of truth while maintaining the existing Lambda-based migration system.

**Part of Epic #526** - RDS Data API to Drizzle ORM Migration
**Issue #539** - Integrate Drizzle-Kit with existing Lambda migration system

## Overview

The migration system has two components:
1. **Drizzle Schema** (`/lib/db/schema/`) - TypeScript source of truth for database structure
2. **Lambda Migrations** (`/infra/database/schema/`) - SQL files executed by AWS Lambda during CDK deploy

## Workflow Diagram

```
Drizzle Schema (TypeScript)
        ↓
npm run drizzle:generate
        ↓
SQL Migration (./drizzle/migrations/)
        ↓
npm run migration:prepare
        ↓
Validated + Formatted SQL
        ↓
Add to MIGRATION_FILES array
        ↓
CDK Deploy → Lambda executes migration
```

## Quick Reference

```bash
# List all migrations and their status
npm run migration:list

# Create empty migration file (manual SQL)
npm run migration:create -- "add-new-feature"

# Generate migration from Drizzle schema changes
npm run drizzle:generate

# Prepare drizzle-generated migration for Lambda
npm run migration:prepare -- "description-of-changes"
```

## Creating Migrations

### Option 1: From Drizzle Schema Changes (Recommended)

Use this when modifying the Drizzle schema files.

**Step 1: Update Drizzle Schema**

```typescript
// lib/db/schema/tables/user-preferences.ts
import { pgTable, serial, integer, varchar, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

export const userPreferences = pgTable("user_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  theme: varchar("theme", { length: 50 }).default("light"),
  language: varchar("language", { length: 10 }).default("en"),
  createdAt: timestamp("created_at").defaultNow(),
});
```

**Step 2: Export from Index**

```typescript
// lib/db/schema/index.ts
export * from "./tables/user-preferences";
```

**Step 3: Generate Migration**

```bash
npm run drizzle:generate
```

**Step 4: Prepare for Lambda**

```bash
npm run migration:prepare -- "add-user-preferences-table"
```

This will:
- Validate SQL for RDS Data API compatibility (no CONCURRENTLY, etc.)
- Rename to Lambda convention (043-add-user-preferences-table.sql)
- Add documentation header
- Copy to `/infra/database/schema/`

**Step 5: Add to MIGRATION_FILES**

Edit `/infra/database/lambda/db-init-handler.ts`:

```typescript
const MIGRATION_FILES = [
  // ... existing migrations ...
  '042-ai-streaming-jobs-pending-index.sql',
  '043-add-user-preferences-table.sql',  // ← ADD THIS LINE
];
```

**Step 6: Deploy**

```bash
cd infra && npx cdk deploy AIStudio-DatabaseStack-Dev
```

### Option 2: Manual Migration

Use this for complex migrations that can't be auto-generated.

```bash
npm run migration:create -- "fix-data-inconsistency"
# Creates: infra/database/schema/043-fix-data-inconsistency.sql
```

Then edit the file and add to MIGRATION_FILES array.

## RDS Data API Compatibility

The Lambda migration system has specific requirements for SQL compatibility.

### NOT Supported

```sql
-- ❌ CONCURRENTLY (requires autocommit mode)
CREATE INDEX CONCURRENTLY idx_name ON table (col);

-- ❌ Dollar-quoted DO blocks
DO $$
BEGIN
  -- ...
END $$;

-- ❌ Transaction control (Lambda manages transactions)
BEGIN;
ALTER TABLE users ADD COLUMN email TEXT;
COMMIT;
```

### Supported

```sql
-- ✅ IF NOT EXISTS (idempotent)
CREATE TABLE IF NOT EXISTS "user_preferences" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL
);

-- ✅ IF NOT EXISTS for indexes
CREATE INDEX IF NOT EXISTS idx_name ON table (col);

-- ✅ ALTER TABLE with IF NOT EXISTS
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

-- ✅ Multiple statements (semicolon-separated)
CREATE TABLE t1 (id SERIAL);
CREATE TABLE t2 (id SERIAL);
```

## Migration Numbering

- Migrations 001-005 are **IMMUTABLE** (initial schema setup)
- Migrations 010+ are additive (new tables, columns, indexes)
- Next number is auto-calculated by helper scripts
- Gaps in numbers are okay (021, 023, 024 is valid)

## Validation

The `migration:prepare` script validates SQL for:
- CONCURRENTLY keyword (blocked)
- Dollar-quoted blocks `DO $$` (blocked)
- Transaction control statements (blocked)

Failed validation will show:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ SQL VALIDATION FAILED - Incompatible patterns detected
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Line 5: CONCURRENTLY
  Problem: CONCURRENTLY operations are incompatible with RDS Data API
  Fix: Use 'CREATE INDEX IF NOT EXISTS' instead
```

## Rollback Procedure

If a migration fails or needs to be reverted:

1. Connect to database:
   ```bash
   psql -h <rds-endpoint> -U <username> -d aistudio
   ```

2. Run the rollback SQL (documented in migration file header)

3. Remove from migration_log:
   ```sql
   DELETE FROM migration_log WHERE description = '043-add-user-preferences-table.sql';
   ```

4. Remove from MIGRATION_FILES array

5. Re-deploy via CDK

## Migration Tracking

Migrations are tracked in the `migration_log` table:

```sql
SELECT * FROM migration_log ORDER BY executed_at DESC;
```

| Column | Description |
|--------|-------------|
| step_number | Sequential execution number |
| description | Migration filename |
| status | 'completed' or 'failed' |
| executed_at | Timestamp of execution |
| error_message | Error details if failed |

## Best Practices

1. **One change per migration** - Keep migrations focused and simple
2. **Use IF NOT EXISTS** - Makes migrations idempotent
3. **Test in dev first** - Deploy to dev before staging/prod
4. **Review generated SQL** - Always inspect drizzle-kit output
5. **Update Drizzle schema** - Keep TypeScript schema in sync with SQL
6. **Document rollback** - Add rollback SQL in migration comments

## File Structure

```
/lib/db/schema/
  ├── index.ts              # Barrel export for all tables
  ├── enums.ts              # PostgreSQL enum types
  ├── relations.ts          # Drizzle relations
  └── tables/               # Table definitions
      ├── users.ts
      ├── roles.ts
      └── ...

/infra/database/
  ├── schema/               # SQL migration files
  │   ├── 001-enums.sql         # IMMUTABLE
  │   ├── 002-tables.sql        # IMMUTABLE
  │   ├── ...
  │   └── 042-*.sql             # Latest migration
  └── lambda/
      └── db-init-handler.ts    # Migration executor

/scripts/drizzle-helpers/
  ├── prepare-migration.ts  # Formats drizzle output for Lambda
  ├── create-migration.ts   # Creates empty migration
  └── list-migrations.ts    # Lists all migrations
```

## Troubleshooting

### "No drizzle-generated migrations found"

Run `npm run drizzle:generate` first to create migrations from schema changes.

### "Could not find MIGRATION_FILES array"

The db-init-handler.ts file format may have changed. Check that the array is defined as:
```typescript
const MIGRATION_FILES = [
  ...
];
```

### Migration runs but table not created

1. Check CloudWatch logs for the Lambda
2. Verify SQL syntax is correct
3. Check migration_log for status

### Drizzle schema out of sync

Use MCP tools to compare:
```bash
mcp__awslabs_postgres-mcp-server__get_table_schema
```

---

*Last Updated: 2025-01-15*
*Related: Issue #539, Epic #526*
