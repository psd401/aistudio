# Database Layer (`/lib/db`)

Database access layer using AWS RDS Data API for Aurora Serverless v2.

## Files

```
/lib/db
├── data-api-adapter.ts       # Core SQL execution
├── field-mapper.ts            # snake_case ↔ camelCase transformation
├── queries/                   # Organized query functions
│   ├── assistant-architect.ts
│   ├── documents.ts
│   ├── nexus.ts
│   └── users.ts
└── README.md
```

## RDS Data API

### Why Data API?

- **No connection pooling needed** - AWS manages connections
- **Serverless-friendly** - Works with Lambda cold starts
- **IAM authentication** - No database passwords
- **Automatic retries** - Built-in resilience

### Connection Configuration

```typescript
// Environment variables required
DATABASE_RESOURCE_ARN=arn:aws:rds:...
DATABASE_SECRET_ARN=arn:aws:secretsmanager:...
DATABASE_NAME=aistudio_dev
```

## Core Functions

### executeSQL

```typescript
import { executeSQL } from '@/lib/db/data-api-adapter';

// Basic query
const users = await executeSQL<User>(
  'SELECT * FROM users WHERE active = :active',
  [{ name: 'active', value: { booleanValue: true } }]
);

// With multiple parameters
const messages = await executeSQL<Message>(
  `SELECT * FROM nexus_messages
   WHERE conversation_id = :convId
   AND role = :role
   ORDER BY created_at DESC
   LIMIT :limit`,
  [
    { name: 'convId', value: { stringValue: conversationId } },
    { name: 'role', value: { stringValue: 'user' } },
    { name: 'limit', value: { longValue: 10 } }
  ]
);
```

### Parameter Types

```typescript
type SqlParameter = {
  name: string;
  value:
    | { stringValue: string }
    | { longValue: number }
    | { doubleValue: number }
    | { booleanValue: boolean }
    | { isNull: true };
};
```

**Mapping:**
- `VARCHAR`, `TEXT` → `stringValue`
- `INT`, `BIGINT`, `SERIAL` → `longValue`
- `DECIMAL`, `NUMERIC`, `FLOAT` → `doubleValue`
- `BOOLEAN` → `booleanValue`
- `NULL` values → `isNull: true`

### Field Transformation

Database uses `snake_case`, application uses `camelCase`:

```typescript
import { transformSnakeToCamel, transformCamelToSnake } from '@/lib/db/field-mapper';

// Reading from DB
const dbRow = { user_id: 1, first_name: 'John', created_at: '2025-01-01' };
const appData = transformSnakeToCamel<User>(dbRow);
// Result: { userId: 1, firstName: 'John', createdAt: '2025-01-01' }

// Writing to DB (less common, usually use SQL directly)
const appData = { userId: 1, firstName: 'John' };
const dbColumns = transformCamelToSnake(appData);
// Result: { user_id: 1, first_name: 'John' }
```

## Query Organization

### Organized Queries (`/lib/db/queries/`)

Group related queries by domain:

```typescript
// /lib/db/queries/users.ts
export async function getUserById(userId: number): Promise<User | null> {
  const results = await executeSQL<User>(
    'SELECT * FROM users WHERE id = :id',
    [{ name: 'id', value: { longValue: userId } }]
  );
  return results[0] || null;
}

export async function getUsersByRole(roleName: string): Promise<User[]> {
  return executeSQL<User>(
    `SELECT u.* FROM users u
     JOIN user_roles ur ON u.id = ur.user_id
     JOIN roles r ON ur.role_id = r.id
     WHERE r.name = :roleName`,
    [{ name: 'roleName', value: { stringValue: roleName } }]
  );
}
```

### Usage in Server Actions

```typescript
"use server"

import { getUserById } from '@/lib/db/queries/users';
import { transformSnakeToCamel } from '@/lib/db/field-mapper';

export async function getUserAction(userId: number): Promise<ActionState<User>> {
  try {
    const user = await getUserById(userId);
    if (!user) {
      throw ErrorFactories.notFound('User', userId);
    }

    // Transform if needed (getUserById may already do this)
    const transformed = transformSnakeToCamel<User>(user);

    return createSuccess(transformed);
  } catch (error) {
    return handleError(error, 'Failed to get user');
  }
}
```

## Best Practices

### 1. Always Use Parameterized Queries

```typescript
// ❌ NEVER do this (SQL injection)
const query = `SELECT * FROM users WHERE email = '${email}'`;

// ✅ Always use parameters
const query = 'SELECT * FROM users WHERE email = :email';
const params = [{ name: 'email', value: { stringValue: email } }];
```

### 2. Type Results

```typescript
// ❌ Untyped
const results = await executeSQL('SELECT * FROM users');

// ✅ Typed
interface UserRow {
  id: number;
  email: string;
  first_name: string;
}
const results = await executeSQL<UserRow>('SELECT * FROM users');
```

### 3. Transform Field Names

```typescript
// ❌ Using snake_case in app
const userId = user.user_id;  // Don't do this

// ✅ Transform to camelCase
const transformed = transformSnakeToCamel<User>(user);
const userId = transformed.userId;
```

### 4. Handle Null Values

```typescript
// For nullable columns
const params = [
  { name: 'optional_field', value: { isNull: true } }
];

// Check for null in results
if (user.lastSignInAt === null) {
  // Handle first-time user
}
```

### 5. Use Transactions for Multi-Step Operations

```typescript
await executeSQL('BEGIN');

try {
  await executeSQL('INSERT INTO users ...');
  await executeSQL('INSERT INTO user_roles ...');
  await executeSQL('COMMIT');
} catch (error) {
  await executeSQL('ROLLBACK');
  throw error;
}
```

## Common Queries

### Insert with RETURNING

```typescript
const result = await executeSQL<{ id: number }>(
  `INSERT INTO users (email, first_name, last_name)
   VALUES (:email, :firstName, :lastName)
   RETURNING id`,
  [
    { name: 'email', value: { stringValue: email } },
    { name: 'firstName', value: { stringValue: firstName } },
    { name: 'lastName', value: { stringValue: lastName } }
  ]
);

const newUserId = result[0].id;
```

### Update

```typescript
await executeSQL(
  `UPDATE users
   SET first_name = :firstName, last_name = :lastName
   WHERE id = :id`,
  [
    { name: 'id', value: { longValue: userId } },
    { name: 'firstName', value: { stringValue: firstName } },
    { name: 'lastName', value: { stringValue: lastName } }
  ]
);
```

### Delete

```typescript
await executeSQL(
  'DELETE FROM user_roles WHERE user_id = :userId',
  [{ name: 'userId', value: { longValue: userId } }]
);
```

### Complex Join

```typescript
const conversations = await executeSQL<ConversationWithMessages>(
  `SELECT
     c.id,
     c.title,
     c.created_at,
     COUNT(m.id) AS message_count,
     MAX(m.created_at) AS last_message_at
   FROM nexus_conversations c
   LEFT JOIN nexus_messages m ON c.id = m.conversation_id
   WHERE c.user_id = :userId
   GROUP BY c.id
   ORDER BY last_message_at DESC NULLS LAST
   LIMIT :limit OFFSET :offset`,
  [
    { name: 'userId', value: { longValue: userId } },
    { name: 'limit', value: { longValue: 50 } },
    { name: 'offset', value: { longValue: 0 } }
  ]
);
```

## Debugging

### Enable Query Logging

```typescript
// Logs SQL + parameters
const results = await executeSQL(query, params, { logQueries: true });
```

### Use MCP Tools

```bash
# Get table schema
mcp__awslabs_postgres-mcp-server__get_table_schema users

# Run test query
mcp__awslabs_postgres-mcp-server__run_query "SELECT * FROM users LIMIT 5"
```

### Common Issues

**Issue: "Parameter {name} not found"**
- Check parameter names match `:name` placeholders
- Verify parameter type matches column type

**Issue: Empty results but no error**
- Verify data exists: `SELECT COUNT(*) FROM table`
- Check WHERE conditions
- Verify parameter values are correct

**Issue: "Invalid parameter type"**
- `longValue` for integers, not `stringValue`
- `booleanValue` for booleans, not `longValue`

## Performance Tips

1. **Use indexes** - Add to frequently queried columns
2. **Limit results** - Always use `LIMIT` for list queries
3. **Avoid N+1 queries** - Use JOINs instead of loops
4. **Batch operations** - Use bulk INSERT when possible

---

**Last Updated**: November 2025
**Database**: Aurora Serverless v2 (PostgreSQL 15)
**Connection**: RDS Data API
**Field Convention**: snake_case (DB) → camelCase (app)
