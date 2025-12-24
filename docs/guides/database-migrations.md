# Database Migrations Guide

This guide covers best practices for writing database migrations that work with the Lambda migration handler and RDS Data API.

## Migration System Overview

Database migrations are managed through:
- **SQL files**: Located in `infra/database/schema/`
- **Lambda handler**: `infra/database/lambda/db-init-handler.ts`
- **Tracking table**: `migration_log` in the database

Migrations run automatically during CDK deployment via a custom resource.

## File Naming Convention

```
XXX-descriptive-name.sql
```

Where `XXX` is a three-digit number (e.g., `042`, `043`). Numbers 001-009 are reserved for initial setup.

## Adding a New Migration

1. Create SQL file in `infra/database/schema/`
2. Add filename to `MIGRATION_FILES` array in `db-init-handler.ts`
3. Deploy with `npx cdk deploy`

## RDS Data API Limitations

The migration system uses AWS RDS Data API, which has specific limitations:

### ❌ CONCURRENTLY Operations Are NOT Supported

**DO NOT USE** these patterns in migrations:

```sql
-- WILL FAIL - CONCURRENTLY is incompatible with RDS Data API
CREATE INDEX CONCURRENTLY idx_name ON table (column);
DROP INDEX CONCURRENTLY idx_name;
REINDEX CONCURRENTLY table_name;
```

**Reason**: `CONCURRENTLY` requires autocommit mode and uses multiple internal transactions, which is incompatible with how RDS Data API executes statements.

**USE INSTEAD**:

```sql
-- WORKS - Standard index creation (briefly blocks writes)
CREATE INDEX IF NOT EXISTS idx_name ON table (column);
DROP INDEX IF EXISTS idx_name;
```

### When You Need Zero-Downtime Index Creation

For large production tables where blocking writes is unacceptable:

1. **Use psql directly** during a maintenance window:
   ```bash
   psql -h <rds-endpoint> -U <username> -d aistudio
   CREATE INDEX CONCURRENTLY idx_name ON large_table (column);
   ```

2. **Create a maintenance script** separate from the Lambda system

3. **Consider partial indexes** to reduce index size and creation time

### Other Considerations

#### Dollar-Quoted Blocks (DO $$ ... $$)

These work but with caveats:
- Cannot contain `CONCURRENTLY`
- Should be simple verification, not complex logic
- The `splitSqlStatements()` function handles them specially

#### IF NOT EXISTS / IF EXISTS

Always use these for idempotency:
```sql
CREATE TABLE IF NOT EXISTS ...
CREATE INDEX IF NOT EXISTS ...
ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...
DROP TABLE IF EXISTS ...
```

## Migration Template

```sql
-- Migration XXX: Brief description
-- Part of Issue #NNN - Related issue title
--
-- Purpose:
-- What this migration does and why
--
-- Notes:
-- Any important considerations
--
-- Rollback:
-- How to undo if needed

-- The actual migration SQL
CREATE TABLE IF NOT EXISTS new_table (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_new_table_name ON new_table (name);
```

## Troubleshooting

### Migration Marked as Failed But Actually Succeeded

This can happen when:
- An error occurs after the DDL succeeds
- Verification blocks (DO $$ ... $$) throw exceptions
- Network issues during status recording

**To fix**: Create a new migration to update `migration_log`:

```sql
-- Migration XXX: Fix migration_log status for migration YYY
UPDATE migration_log
SET status = 'completed', error_message = NULL
WHERE description = 'YYY-original-migration.sql'
  AND status = 'failed';
```

### Handler Version

The handler logs its version on each run. Check CloudWatch Logs:
```
Handler version: 2025-12-24-v12 - Add CONCURRENTLY detection, fix migration 042
```

## References

- [PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html)
- [RDS Data API Documentation](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html)
- [Issue #565 - Migration 042 CONCURRENTLY incompatibility](https://github.com/psd401/aistudio/issues/565)
