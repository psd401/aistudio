# Drizzle Troubleshooting Guide

Common issues and solutions when working with Drizzle ORM in AI Studio.

**Part of Epic #526** - RDS Data API to Drizzle ORM Migration

## Table of Contents

1. [Type Inference Issues](#type-inference-issues)
2. [Migration Failures](#migration-failures)
3. [JSONB Type Mismatches](#jsonb-type-mismatches)
4. [Circuit Breaker Issues](#circuit-breaker-issues)
5. [RDS Data API Errors](#rds-data-api-errors)
6. [Schema Sync Problems](#schema-sync-problems)
7. [Performance Issues](#performance-issues)
8. [Common Error Messages](#common-error-messages)

---

## Type Inference Issues

### Problem: TypeScript can't infer return type

```typescript
// Error: Type 'unknown[]' is not assignable to type...
const user = await db.select().from(users);
```

**Solution**: Use the schema's inferred types:

```typescript
import type { InferSelectModel } from "drizzle-orm";
import { users } from "@/lib/db/schema";

type User = InferSelectModel<typeof users>;

const user: User[] = await executeQuery(
  (db) => db.select().from(users),
  "getUsers"
);
```

### Problem: Partial select type mismatch

```typescript
// Error when selecting specific columns
const result = await db.select({ id: users.id, email: users.email }).from(users);
// result[0].firstName  // Error: Property doesn't exist
```

**Solution**: Define inline type or use explicit shape:

```typescript
type UserBasic = { id: number; email: string };

const result = await executeQuery(
  (db) =>
    db.select({ id: users.id, email: users.email }).from(users),
  "getUserBasics"
) as UserBasic[];
```

### Problem: sql`` template literal returns unknown

```typescript
// count is typed as unknown
const result = await db.select({ count: sql`count(*)` }).from(users);
```

**Solution**: Add type annotation to sql template:

```typescript
const result = await db.select({
  count: sql<number>`count(*)::int`
}).from(users);
// Now count is typed as number
```

---

## Migration Failures

### Problem: "No drizzle-generated migrations found"

```bash
npm run migration:prepare -- "description"
# Error: No drizzle-generated migrations found in ./drizzle/migrations
```

**Solution**: Generate migrations first:

```bash
npm run drizzle:generate
# Then run prepare
npm run migration:prepare -- "description"
```

### Problem: "Could not find MIGRATION_FILES array"

**Solution**: Verify the array format in `db-init-handler.ts`:

```typescript
// Must be exactly this format:
const MIGRATION_FILES = [
  '001-initial.sql',
  // ...
];
```

### Problem: Migration validation fails

```bash
❌ SQL VALIDATION FAILED - Incompatible patterns detected
Line 5: CONCURRENTLY
```

**Solution**: Remove unsupported patterns:

| Pattern | Problem | Solution |
|---------|---------|----------|
| `CREATE INDEX CONCURRENTLY` | Not supported by RDS Data API | Use `CREATE INDEX IF NOT EXISTS` |
| `DO $$ ... $$` | Dollar-quoted blocks unsupported | Use regular functions |
| `BEGIN; ... COMMIT;` | Lambda manages transactions | Remove transaction control |

### Problem: Migration runs but table not created

**Diagnostic steps:**

1. Check CloudWatch logs:
   ```bash
   aws logs tail /aws/lambda/aistudio-db-init --since 1h
   ```

2. Check migration_log table:
   ```sql
   SELECT * FROM migration_log
   WHERE description LIKE '%your-migration%'
   ORDER BY executed_at DESC;
   ```

3. Verify SQL syntax locally:
   ```bash
   psql -h localhost -d test -f your-migration.sql
   ```

---

## JSONB Type Mismatches

### Problem: Runtime JSONB value doesn't match TypeScript type

```typescript
// Schema says settings is UserSettings type
// But runtime data has different shape
const prefs = await db.select().from(userPreferences);
prefs[0].settings.theme;  // Runtime: undefined, TypeScript: string
```

**Solution**: Add runtime validation:

```typescript
import { z } from "zod";

const UserSettingsSchema = z.object({
  theme: z.enum(["light", "dark", "system"]).optional(),
  notifications: z.boolean().optional(),
});

const prefs = await executeQuery(
  (db) => db.select().from(userPreferences),
  "getPrefs"
);

// Validate at runtime
const validatedSettings = UserSettingsSchema.parse(prefs[0]?.settings);
```

### Problem: JSONB query returns null for nested field

```typescript
// Returns null even when field exists
sql`${prefs.settings}->>'theme'`
```

**Possible causes:**

1. **Field doesn't exist**: Check actual data structure
2. **Case sensitivity**: PostgreSQL JSONB keys are case-sensitive
3. **Nested path wrong**: Use `->>` for text, `->` for JSON object

**Solution**: Use correct operator:

```typescript
// Get text value
sql`${prefs.settings}->>'theme'`  // Returns: "dark"

// Get JSON object
sql`${prefs.settings}->'nested'`  // Returns: {"key": "value"}

// Deeply nested
sql`${prefs.settings}->'level1'->'level2'->>'value'`
```

### Problem: Cannot insert JSONB - type error

```typescript
// Error: Argument of type 'object' is not assignable
await db.insert(table).values({
  settings: { theme: "dark" }  // Error
});
```

**Solution**: Cast or use typed object:

```typescript
// Option 1: Explicit type
const settings: UserSettings = { theme: "dark", notifications: true };
await db.insert(table).values({ settings });

// Option 2: Type assertion
await db.insert(table).values({
  settings: { theme: "dark" } as UserSettings
});
```

---

## Circuit Breaker Issues

### Problem: "Circuit breaker is open" error

```
Error: Circuit breaker is open - database temporarily unavailable
```

**Diagnosis:**

```typescript
import { getDatabaseCircuitState } from "@/lib/db/drizzle-client";

const state = getDatabaseCircuitState();
console.log(state);
// { state: "open", failures: 5, lastFailure: Date, ... }
```

**Solutions:**

1. **Wait for recovery**: Circuit closes automatically after 30 seconds
2. **Check database health**: Verify Aurora cluster status in AWS Console
3. **Manual reset** (use with caution):
   ```typescript
   import { resetDatabaseCircuit } from "@/lib/db/drizzle-client";
   resetDatabaseCircuit();
   ```

### Problem: Too many retries exhausting connections

**Solution**: Adjust retry options:

```typescript
await executeQuery(
  (db) => db.select().from(users),
  "getUsers",
  {
    maxRetries: 2,        // Reduce from default 3
    initialDelay: 200,    // Increase from 100ms
    maxDelay: 3000,       // Reduce from 5000ms
  }
);
```

---

## RDS Data API Errors

### Problem: "BadRequestException: Database returned more than the allowed response size limit"

**Cause**: Query returns too much data (>1MB response limit)

**Solutions:**

1. Add pagination:
   ```typescript
   .limit(100).offset(0)
   ```

2. Select fewer columns:
   ```typescript
   .select({ id: users.id, email: users.email })  // Not all columns
   ```

3. Add WHERE clause to reduce results:
   ```typescript
   .where(gt(users.createdAt, lastWeek))
   ```

### Problem: "StatementTimeoutException: Query timed out"

**Cause**: Query execution exceeded 45-second limit

**Solutions:**

1. Add index for slow queries
2. Simplify complex JOINs
3. Use pagination for large result sets
4. Check for missing WHERE clauses on large tables

### Problem: "Transaction was aborted"

**Cause**: Error during transaction caused automatic rollback

**Diagnosis**: Check the error message for root cause:

```typescript
try {
  await executeTransaction(async (tx) => { ... }, "operation");
} catch (error) {
  console.error("Transaction failed:", error.message);
  // Check for constraint violations, foreign key errors, etc.
}
```

---

## Schema Sync Problems

### Problem: Drizzle schema doesn't match database

**Diagnosis with MCP tools:**

```bash
# Get actual table schema
mcp__awslabs_postgres-mcp-server__get_table_schema table_name="users"

# Compare with Drizzle definition
# Check: lib/db/schema/tables/users.ts
```

**Solutions:**

1. **Schema out of date**: Re-run introspection
   ```bash
   npm run drizzle:introspect
   ```

2. **Missing migration**: Create and deploy missing migration

3. **Column type mismatch**: Update Drizzle schema to match actual DB:
   ```typescript
   // If DB has varchar(255) but schema says varchar(100)
   email: varchar("email", { length: 255 })  // Match actual
   ```

### Problem: Foreign key constraint not enforced

**Cause**: Drizzle defines reference, but migration didn't create constraint

**Solution**: Create migration to add constraint:

```sql
ALTER TABLE user_roles
ADD CONSTRAINT fk_user_roles_user_id
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
```

---

## Performance Issues

### Problem: Slow queries

**Diagnostic steps:**

1. **Check for missing indexes:**
   ```sql
   EXPLAIN ANALYZE SELECT * FROM users WHERE email = 'test@example.com';
   ```

2. **Look for Seq Scan on large tables** - indicates missing index

3. **Check query patterns in CloudWatch Metrics**

**Solutions:**

1. Add index in schema:
   ```typescript
   export const users = pgTable("users", {
     // columns...
   }, (table) => ({
     emailIdx: index("users_email_idx").on(table.email),
   }));
   ```

2. Create migration for index:
   ```sql
   CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
   ```

### Problem: N+1 query pattern

```typescript
// BAD: N+1 queries
const users = await getUsers();
for (const user of users) {
  const roles = await getUserRoles(user.id);  // N additional queries!
}
```

**Solution**: Use JOINs:

```typescript
// GOOD: Single query with JOIN
const usersWithRoles = await executeQuery(
  (db) =>
    db
      .select({
        userId: users.id,
        email: users.email,
        roleName: roles.name,
      })
      .from(users)
      .leftJoin(userRoles, eq(users.id, userRoles.userId))
      .leftJoin(roles, eq(userRoles.roleId, roles.id)),
  "getUsersWithRoles"
);
```

### Problem: Connection pool exhausted

**Note**: RDS Data API doesn't use traditional connection pools, but you can hit API rate limits.

**Solution**:
- Batch operations where possible
- Add delays between bulk operations
- Use transactions for multiple related writes

---

## Common Error Messages

### "column X does not exist"

**Cause**: Schema references column that doesn't exist in database

**Solution**:
- Check column name spelling and case
- Verify migration was applied
- Use MCP tools to check actual schema

### "relation X does not exist"

**Cause**: Table doesn't exist

**Solution**:
- Run pending migrations
- Check table name spelling
- Verify database connection is to correct database

### "duplicate key value violates unique constraint"

**Cause**: Attempting to insert duplicate value

**Solution**:
```typescript
// Use onConflictDoNothing for idempotent inserts
await db.insert(table).values(data).onConflictDoNothing();

// Or onConflictDoUpdate for upsert
await db.insert(table).values(data).onConflictDoUpdate({
  target: table.uniqueColumn,
  set: { updatedAt: new Date() },
});
```

### "null value in column X violates not-null constraint"

**Cause**: Inserting NULL into NOT NULL column

**Solution**:
- Provide value for required column
- Add default in schema: `.default("value")`
- Check that data transformation isn't producing undefined

### "operator does not exist: jsonb = text"

**Cause**: Comparing JSONB to string without proper casting

**Solution**:
```typescript
// Wrong
.where(eq(table.jsonbCol, "value"))

// Correct - cast to text
.where(sql`${table.jsonbCol}::text = 'value'`)

// Or use ->> operator for string extraction
.where(sql`${table.jsonbCol}->>'key' = 'value'`)
```

---

## Getting Help

1. **Check Drizzle Docs**: https://orm.drizzle.team/docs/overview
2. **Search GitHub Issues**: https://github.com/drizzle-team/drizzle-orm/issues
3. **Use MCP Tools** to inspect live database
4. **Check CloudWatch Logs** for Lambda errors
5. **Review Related Docs**:
   - [Migration Guide](./drizzle-migration-guide.md)
   - [Query Patterns](./drizzle-patterns.md)

---

*Last Updated: 2025-01-15*
*Part of Epic #526 - RDS Data API to Drizzle ORM Migration*
