# Drizzle Query Patterns

Common query patterns and best practices for Drizzle ORM in AI Studio.

**Part of Epic #526** - RDS Data API to Drizzle ORM Migration

## Table of Contents

1. [Basic CRUD Operations](#basic-crud-operations)
2. [Filtering and Conditions](#filtering-and-conditions)
3. [Joins](#joins)
4. [Transactions](#transactions)
5. [JSONB Operations](#jsonb-operations)
6. [Pagination](#pagination)
7. [Aggregations](#aggregations)
8. [Subqueries](#subqueries)
9. [Raw SQL](#raw-sql)
10. [Error Handling](#error-handling)

---

## Basic CRUD Operations

### Import Pattern

```typescript
import { eq, and, or, desc, asc, sql } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import { users, userRoles, roles } from "@/lib/db/schema";
```

### SELECT

```typescript
// Select all columns
const allUsers = await executeQuery(
  (db) => db.select().from(users),
  "getAllUsers"
);

// Select specific columns
const userList = await executeQuery(
  (db) =>
    db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
      })
      .from(users),
  "getUserList"
);

// Select with alias
const userWithFullName = await executeQuery(
  (db) =>
    db
      .select({
        id: users.id,
        fullName: sql<string>`${users.firstName} || ' ' || ${users.lastName}`,
      })
      .from(users),
  "getUsersWithFullName"
);
```

### INSERT

```typescript
// Single insert with returning
const newUser = await executeQuery(
  (db) =>
    db
      .insert(users)
      .values({
        email: "user@example.com",
        cognitoSub: "sub-123",
        firstName: "John",
        lastName: "Doe",
      })
      .returning(),
  "createUser"
);
// Returns: [{ id: 1, email: "user@example.com", ... }]

// Batch insert
const newUsers = await executeQuery(
  (db) =>
    db
      .insert(users)
      .values([
        { email: "user1@example.com", cognitoSub: "sub-1" },
        { email: "user2@example.com", cognitoSub: "sub-2" },
      ])
      .returning(),
  "batchCreateUsers"
);
```

### UPDATE

```typescript
// Update with where clause
const updatedUser = await executeQuery(
  (db) =>
    db
      .update(users)
      .set({
        firstName: "Jane",
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning(),
  "updateUser"
);

// Conditional update with SQL
await executeQuery(
  (db) =>
    db
      .update(users)
      .set({
        roleVersion: sql`COALESCE(${users.roleVersion}, 0) + 1`,
      })
      .where(eq(users.id, userId)),
  "incrementRoleVersion"
);
```

### DELETE

```typescript
// Delete with returning
const deleted = await executeQuery(
  (db) => db.delete(users).where(eq(users.id, userId)).returning(),
  "deleteUser"
);

// Delete without returning
await executeQuery(
  (db) => db.delete(userRoles).where(eq(userRoles.userId, userId)),
  "deleteUserRoles"
);
```

### UPSERT (ON CONFLICT)

```typescript
// Upsert - insert or update on conflict
const user = await executeQuery(
  (db) =>
    db
      .insert(users)
      .values({
        cognitoSub: "sub-123",
        email: "user@example.com",
        firstName: "John",
      })
      .onConflictDoUpdate({
        target: users.cognitoSub,
        set: {
          email: "user@example.com",
          // Preserve existing name if new value is null
          firstName: sql`COALESCE(${firstName}, ${users.firstName})`,
          updatedAt: new Date(),
        },
      })
      .returning(),
  "upsertUser"
);

// Upsert - ignore if exists
await executeQuery(
  (db) =>
    db
      .insert(userRoles)
      .values({ userId, roleId })
      .onConflictDoNothing(),
  "assignRoleIdempotent"
);
```

---

## Filtering and Conditions

### Basic Comparisons

```typescript
import { eq, ne, gt, gte, lt, lte, like, ilike, isNull, isNotNull } from "drizzle-orm";

// Equals
.where(eq(users.id, 1))

// Not equals
.where(ne(users.status, "deleted"))

// Greater than
.where(gt(users.createdAt, new Date("2025-01-01")))

// Less than or equal
.where(lte(users.loginCount, 10))

// LIKE (case-sensitive)
.where(like(users.email, "%@gmail.com"))

// ILIKE (case-insensitive)
.where(ilike(users.email, "%@GMAIL.COM"))

// IS NULL
.where(isNull(users.deletedAt))

// IS NOT NULL
.where(isNotNull(users.firstName))
```

### Logical Operators

```typescript
import { and, or, not } from "drizzle-orm";

// AND
.where(
  and(
    eq(users.isActive, true),
    gt(users.createdAt, startDate)
  )
)

// OR
.where(
  or(
    eq(users.role, "admin"),
    eq(users.role, "moderator")
  )
)

// Complex nested conditions
.where(
  and(
    eq(users.isActive, true),
    or(
      eq(users.role, "admin"),
      and(
        eq(users.role, "editor"),
        isNotNull(users.verifiedAt)
      )
    )
  )
)
```

### IN / NOT IN

```typescript
import { inArray, notInArray } from "drizzle-orm";

// IN
.where(inArray(users.id, [1, 2, 3]))

// NOT IN
.where(notInArray(users.status, ["deleted", "suspended"]))
```

### BETWEEN

```typescript
import { between } from "drizzle-orm";

.where(between(users.createdAt, startDate, endDate))
```

---

## Joins

### INNER JOIN

```typescript
const usersWithRoles = await executeQuery(
  (db) =>
    db
      .select({
        userId: users.id,
        email: users.email,
        roleName: roles.name,
      })
      .from(users)
      .innerJoin(userRoles, eq(users.id, userRoles.userId))
      .innerJoin(roles, eq(userRoles.roleId, roles.id)),
  "getUsersWithRoles"
);
```

### LEFT JOIN

```typescript
const usersWithOptionalRoles = await executeQuery(
  (db) =>
    db
      .select({
        user: users,
        role: roles,
      })
      .from(users)
      .leftJoin(userRoles, eq(users.id, userRoles.userId))
      .leftJoin(roles, eq(userRoles.roleId, roles.id)),
  "getUsersWithOptionalRoles"
);
```

### Multiple Tables

```typescript
const fullUserData = await executeQuery(
  (db) =>
    db
      .select({
        id: users.id,
        email: users.email,
        roleName: roles.name,
        toolName: tools.name,
      })
      .from(users)
      .innerJoin(userRoles, eq(users.id, userRoles.userId))
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .innerJoin(roleTools, eq(roles.id, roleTools.roleId))
      .innerJoin(tools, eq(roleTools.toolId, tools.id)),
  "getFullUserData"
);
```

---

## Transactions

### Basic Transaction

```typescript
import { executeTransaction } from "@/lib/db/drizzle-client";

const result = await executeTransaction(
  async (tx) => {
    // Delete old roles
    await tx.delete(userRoles).where(eq(userRoles.userId, userId));

    // Insert new roles
    await tx.insert(userRoles).values(
      roleIds.map((roleId) => ({ userId, roleId }))
    );

    // Update user version
    await tx
      .update(users)
      .set({ roleVersion: sql`${users.roleVersion} + 1` })
      .where(eq(users.id, userId));

    return { success: true };
  },
  "updateUserRoles"
);
```

### Transaction with Validation

```typescript
await executeTransaction(
  async (tx) => {
    // Lookup roles first
    const roleRecords = await tx
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(inArray(roles.name, roleNames));

    // Validate all roles exist
    if (roleRecords.length !== roleNames.length) {
      const found = roleRecords.map((r) => r.name);
      const missing = roleNames.filter((n) => !found.includes(n));
      throw new Error(`Roles not found: ${missing.join(", ")}`);
    }

    // Proceed with insert
    await tx.insert(userRoles).values(
      roleRecords.map((r) => ({ userId, roleId: r.id }))
    );
  },
  "assignRolesWithValidation"
);
```

### Transaction Options

```typescript
await executeTransaction(
  async (tx) => {
    // ... operations
  },
  "operationName",
  {
    isolationLevel: "serializable",  // Transaction isolation
    accessMode: "read write",        // Access mode
    maxRetries: 5,                   // Retry attempts
  }
);
```

### Side Effect Warning

```typescript
// WRONG - Side effects in transaction will be duplicated on retry
await executeTransaction(
  async (tx) => {
    await tx.insert(orders).values({ ... });
    await sendEmailNotification(orderId);  // BAD!
  },
  "createOrder"
);

// CORRECT - Side effects after transaction
const order = await executeTransaction(
  async (tx) => {
    return await tx.insert(orders).values({ ... }).returning();
  },
  "createOrder"
);
// Side effects AFTER transaction succeeds
await sendEmailNotification(order[0].id);
```

---

## JSONB Operations

### Type-Safe JSONB

```typescript
// Define the type
interface UserSettings {
  theme: "light" | "dark" | "system";
  notifications: boolean;
  language: string;
}

// Query with type safety
const prefs = await executeQuery(
  (db) => db.select().from(userPreferences).where(eq(userPreferences.userId, userId)),
  "getUserPrefs"
);

// TypeScript knows the shape
const theme = prefs[0]?.settings?.theme;  // "light" | "dark" | "system"
```

### JSONB Queries

```typescript
// Access nested field
const darkThemeUsers = await executeQuery(
  (db) =>
    db
      .select()
      .from(userPreferences)
      .where(sql`${userPreferences.settings}->>'theme' = 'dark'`),
  "getDarkThemeUsers"
);

// Check if key exists
const usersWithNotifications = await executeQuery(
  (db) =>
    db
      .select()
      .from(userPreferences)
      .where(sql`${userPreferences.settings} ? 'notifications'`),
  "getUsersWithNotifications"
);

// JSONB contains
const usersWithTag = await executeQuery(
  (db) =>
    db
      .select()
      .from(conversations)
      .where(sql`${conversations.metadata} @> '{"tags": ["important"]}'`),
  "getImportantConversations"
);
```

### Update JSONB

```typescript
// Update entire JSONB
await executeQuery(
  (db) =>
    db
      .update(userPreferences)
      .set({ settings: newSettings })
      .where(eq(userPreferences.userId, userId)),
  "updateSettings"
);

// Update specific field (PostgreSQL jsonb_set)
await executeQuery(
  (db) =>
    db
      .update(userPreferences)
      .set({
        settings: sql`jsonb_set(
          ${userPreferences.settings},
          '{theme}',
          '"dark"'
        )`,
      })
      .where(eq(userPreferences.userId, userId)),
  "updateTheme"
);
```

---

## Pagination

### Offset Pagination

```typescript
const PAGE_SIZE = 20;

const getPage = async (page: number) => {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(users)
        .orderBy(desc(users.createdAt))
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE),
    "getUsersPage"
  );
};
```

### Cursor Pagination (Recommended for Large Datasets)

```typescript
const getNextPage = async (cursor: Date | null, limit: number = 20) => {
  const query = cursor
    ? db
        .select()
        .from(users)
        .where(lt(users.createdAt, cursor))
        .orderBy(desc(users.createdAt))
        .limit(limit + 1)
    : db
        .select()
        .from(users)
        .orderBy(desc(users.createdAt))
        .limit(limit + 1);

  const results = await executeQuery(() => query, "getUsersCursor");

  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, -1) : results;
  const nextCursor = hasMore ? items[items.length - 1].createdAt : null;

  return { items, nextCursor, hasMore };
};
```

### Count with Pagination

```typescript
const getPageWithCount = async (page: number, pageSize: number = 20) => {
  const [items, countResult] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select()
          .from(users)
          .orderBy(desc(users.createdAt))
          .limit(pageSize)
          .offset((page - 1) * pageSize),
      "getUsers"
    ),
    executeQuery(
      (db) => db.select({ count: sql<number>`count(*)` }).from(users),
      "countUsers"
    ),
  ]);

  return {
    items,
    total: countResult[0].count,
    page,
    pageSize,
    totalPages: Math.ceil(countResult[0].count / pageSize),
  };
};
```

---

## Aggregations

### COUNT

```typescript
const userCount = await executeQuery(
  (db) =>
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.isActive, true)),
  "countActiveUsers"
);
// Returns: [{ count: 42 }]
```

### GROUP BY

```typescript
const roleStats = await executeQuery(
  (db) =>
    db
      .select({
        roleName: roles.name,
        userCount: sql<number>`count(${userRoles.userId})::int`,
      })
      .from(roles)
      .leftJoin(userRoles, eq(roles.id, userRoles.roleId))
      .groupBy(roles.id, roles.name),
  "getRoleStats"
);
```

### SUM, AVG, MIN, MAX

```typescript
const stats = await executeQuery(
  (db) =>
    db
      .select({
        totalTokens: sql<number>`sum(${messages.tokenCount})::int`,
        avgTokens: sql<number>`avg(${messages.tokenCount})::float`,
        maxTokens: sql<number>`max(${messages.tokenCount})::int`,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId)),
  "getMessageStats"
);
```

---

## Subqueries

### Subquery in WHERE

```typescript
const sq = db
  .select({ userId: userRoles.userId })
  .from(userRoles)
  .innerJoin(roles, eq(userRoles.roleId, roles.id))
  .where(eq(roles.name, "admin"));

const admins = await executeQuery(
  (db) => db.select().from(users).where(inArray(users.id, sq)),
  "getAdminUsers"
);
```

### Subquery with Aggregation

```typescript
const usersWithMessageCount = await executeQuery(
  (db) =>
    db
      .select({
        id: users.id,
        email: users.email,
        messageCount: sql<number>`(
          SELECT COUNT(*) FROM messages
          WHERE messages.user_id = ${users.id}
        )::int`,
      })
      .from(users),
  "getUsersWithMessageCount"
);
```

---

## Raw SQL

### sql Template Tag

```typescript
import { sql } from "drizzle-orm";

// Simple expression
const results = await executeQuery(
  (db) =>
    db
      .select({
        id: users.id,
        fullName: sql<string>`${users.firstName} || ' ' || ${users.lastName}`,
      })
      .from(users),
  "getUserFullNames"
);

// With type annotation
const count = await executeQuery(
  (db) =>
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(users),
  "countUsers"
);
```

### Typed SQL Fragments

```typescript
// Reusable SQL fragment
const isActive = sql<boolean>`${users.isActive} = true AND ${users.deletedAt} IS NULL`;

await executeQuery(
  (db) => db.select().from(users).where(isActive),
  "getActiveUsers"
);
```

---

## Error Handling

### Standard Pattern

```typescript
import { ErrorFactories } from "@/lib/error-utils";

export async function getUserById(userId: number) {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    "getUserById"
  );

  if (!result[0]) {
    throw ErrorFactories.dbRecordNotFound("users", userId);
  }

  return result[0];
}
```

### Circuit Breaker Awareness

```typescript
import { getDatabaseCircuitState } from "@/lib/db/drizzle-client";

async function healthCheck() {
  const state = getDatabaseCircuitState();

  if (state.state === "open") {
    return {
      status: "degraded",
      database: "unavailable",
      circuitState: state,
    };
  }

  return { status: "healthy", database: "available" };
}
```

---

## Related Documentation

- [Drizzle Migration Guide](./drizzle-migration-guide.md)
- [Drizzle Troubleshooting](./drizzle-troubleshooting.md)
- [Drizzle ORM Docs](https://orm.drizzle.team/docs/overview)

---

*Last Updated: 2025-01-15*
*Part of Epic #526 - RDS Data API to Drizzle ORM Migration*
