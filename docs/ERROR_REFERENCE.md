# Error Reference

Complete error codes, handling patterns, and debugging guide for AI Studio.

## Error Handling Architecture

### ActionState Pattern

All server actions return `ActionState<T>`:

```typescript
type ActionState<T> = {
  isSuccess: boolean;
  data?: T;
  message?: string;
  error?: {
    message: string;
    code?: string;
    level?: ErrorLevel;
    details?: ValidationError[] | unknown;
  };
};

type ErrorLevel = 'warning' | 'error' | 'fatal';
```

### Error Factories

Located in `/lib/error-utils.ts`:

```typescript
import { ErrorFactories } from '@/lib/error-utils';

// Authentication
ErrorFactories.authNoSession()
ErrorFactories.authInsufficientPermissions()

// Validation
ErrorFactories.validationFailed([
  { field: 'email', message: 'Invalid format' }
])

// Not Found
ErrorFactories.notFound('User', userId)

// Database
ErrorFactories.databaseError(originalError)
```

## Error Categories

### Authentication Errors

#### AUTH_NO_SESSION
**Code:** `AUTH_NO_SESSION`
**HTTP Status:** 401
**Message:** "No active session found"

**Cause:** User not logged in or session expired

**Solution:**
```typescript
// Redirect to login
redirect('/auth/signin');
```

#### AUTH_INSUFFICIENT_PERMISSIONS
**Code:** `AUTH_INSUFFICIENT_PERMISSIONS`
**HTTP Status:** 403
**Message:** "You do not have permission to access this resource"

**Cause:** User lacks required role or tool permission

**Solution:**
```sql
-- Grant role permission
INSERT INTO user_roles (user_id, role_id)
VALUES (:userId, :roleId);

-- Or grant tool permission to role
INSERT INTO role_tools (role_id, tool_id)
SELECT r.id, t.id
FROM roles r, tools t
WHERE r.name = 'staff' AND t.identifier = 'assistant-architect';
```

### Validation Errors

#### VALIDATION_FAILED
**Code:** `VALIDATION_FAILED`
**HTTP Status:** 400
**Message:** Validation errors with field-specific details

**Structure:**
```typescript
{
  error: {
    message: "Validation failed",
    code: "VALIDATION_FAILED",
    details: [
      { field: "email", message: "Invalid email format" },
      { field: "password", message: "Must be at least 8 characters" }
    ]
  }
}
```

**Solution:** Fix input fields based on `details` array

### Database Errors

#### DATABASE_ERROR
**Code:** `DATABASE_ERROR`
**HTTP Status:** 500
**Message:** Varies based on underlying error

**Common Causes:**
1. Connection timeout
2. Constraint violation
3. Invalid SQL syntax
4. Missing table/column

**Example:**
```typescript
import { executeQuery } from "@/lib/db/drizzle-client";
import { users } from "@/lib/db/schema";

try {
  await executeQuery(
    (db) => db.insert(users).values({ email: params.email }),
    "insertUser"
  );
} catch (error) {
  // Logged with full stack trace
  throw ErrorFactories.databaseError(error);
}
```

**Debugging:**
```typescript
// Queries are automatically logged with context
// Check logs for requestId and operation name
const result = await executeQuery(
  (db) => db.select().from(users),
  "debugQuery"  // Shows in logs as "executeWithRetry_debugQuery"
);
```

### Not Found Errors

#### NOT_FOUND
**Code:** `NOT_FOUND`
**HTTP Status:** 404
**Message:** "{Resource} not found: {id}"

**Example:**
```typescript
const user = await getUserById(id);
if (!user) {
  throw ErrorFactories.notFound('User', id);
}
```

### Streaming Errors

#### CIRCUIT_BREAKER_OPEN
**Code:** `CIRCUIT_BREAKER_OPEN`
**HTTP Status:** 503
**Message:** "Circuit breaker is open for provider {provider}"

**Cause:** Too many consecutive failures to AI provider

**Solution:** Wait 30 seconds for auto-reset or restart service

#### STREAM_TIMEOUT
**Code:** `STREAM_TIMEOUT`
**HTTP Status:** 504
**Message:** "Stream timeout after {duration}ms"

**Cause:** AI provider took too long to respond

**Solution:**
```typescript
// Increase timeout for reasoning models
const config = {
  timeout: capabilities.supportsReasoning ? 120000 : 60000
};
```

### Rate Limiting Errors

#### RATE_LIMIT_EXCEEDED
**Code:** `RATE_LIMIT_EXCEEDED`
**HTTP Status:** 429
**Message:** "Rate limit exceeded for {resource}"

**Headers:**
```
Retry-After: 60
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1704067200
```

**Solution:** Wait for `Retry-After` seconds

## Error Handling Patterns

### Client-Side (React)

```typescript
import { useActionState } from 'react';

function MyComponent() {
  const [state, formAction, isPending] = useActionState(
    myServerAction,
    { isSuccess: false }
  );

  if (state.error) {
    return <ErrorDisplay error={state.error} />;
  }

  return <form action={formAction}>...</form>;
}
```

### API Routes

```typescript
export async function POST(req: Request) {
  const requestId = generateRequestId();
  const log = createLogger({ requestId });

  try {
    const session = await getServerSession();
    if (!session) {
      log.warn('Unauthorized request');
      return new Response('Unauthorized', { status: 401 });
    }

    // Business logic...
    return Response.json({ success: true });

  } catch (error) {
    log.error('Request failed', { error });

    return new Response(
      JSON.stringify({
        error: error.message,
        requestId
      }),
      {
        status: error.status || 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}
```

### Server Actions

```typescript
"use server"

import {
  handleError,
  createSuccess,
  ErrorFactories
} from '@/lib/error-utils';
import { createLogger, generateRequestId } from '@/lib/logger';

export async function myAction(params): Promise<ActionState<Result>> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, action: 'myAction' });

  try {
    // Validation
    if (!params.required) {
      throw ErrorFactories.validationFailed([
        { field: 'required', message: 'This field is required' }
      ]);
    }

    // Auth check
    const session = await getServerSession();
    if (!session) {
      throw ErrorFactories.authNoSession();
    }

    // Business logic
    const result = await doSomething(params);

    return createSuccess(result, 'Operation completed');

  } catch (error) {
    return handleError(error, 'Operation failed', {
      context: 'myAction',
      requestId
    });
  }
}
```

## Error Logging

### Structured Logging

```typescript
import { createLogger } from '@/lib/logger';

const log = createLogger({
  module: 'myModule',
  requestId: 'req-123'
});

// Log levels
log.debug('Debug info', { data });
log.info('Informational', { userId });
log.warn('Warning', { issue });
log.error('Error occurred', { error, context });
```

### CloudWatch Integration

All logs are sent to CloudWatch Logs with structured JSON format:

```json
{
  "timestamp": "2025-01-15T10:30:45.123Z",
  "level": "error",
  "module": "streaming",
  "requestId": "req-abc123",
  "message": "Stream failed",
  "error": {
    "message": "Connection timeout",
    "stack": "...",
    "code": "ETIMEDOUT"
  },
  "context": {
    "provider": "openai",
    "modelId": "gpt-5-turbo"
  }
}
```

### Error Metrics

CloudWatch metrics automatically tracked:

- `ErrorCount` by module/action
- `ErrorRate` percentage
- `ErrorType` distribution
- `ResponseTime` for failed requests

## Debugging Workflow

1. **Identify error source:**
   - Client error (4xx) = Request issue
   - Server error (5xx) = Backend issue

2. **Check request ID:**
   ```typescript
   // All errors include requestId
   const { requestId } = error;
   ```

3. **Search CloudWatch Logs:**
   ```bash
   aws logs filter-log-events \
     --log-group-name /aws/ecs/aistudio-frontend-dev \
     --filter-pattern "req-abc123"
   ```

4. **Trace execution:**
   ```typescript
   // Logs include context throughout execution
   2025-01-15T10:30:45 [INFO] Action started { requestId, action: 'executeAssistantArchitect' }
   2025-01-15T10:30:46 [INFO] Loading tool { requestId, toolId: 42 }
   2025-01-15T10:30:47 [ERROR] Execution failed { requestId, error }
   ```

5. **Check related metrics:**
   - CloudWatch Dashboard for system health
   - Error rate spike?
   - Provider availability?

## Common Error Scenarios

### Scenario: User can't access feature

**Error:** `AUTH_INSUFFICIENT_PERMISSIONS`

**Debug Steps:**
1. Verify user's roles:
```sql
SELECT r.name FROM user_roles ur
JOIN roles r ON ur.role_id = r.id
WHERE ur.user_id = :userId;
```

2. Check role permissions:
```sql
SELECT t.identifier FROM role_tools rt
JOIN tools t ON rt.tool_id = t.id
WHERE rt.role_id = :roleId;
```

3. Grant access if appropriate

### Scenario: Database query returns no results

**Error:** No error, but `data` is empty `[]`

**Debug Steps:**
1. Enable query logging
2. Verify parameters match column types
3. Check table actually has data:
```sql
SELECT COUNT(*) FROM table_name WHERE condition;
```

4. Use MCP tools to inspect schema

### Scenario: Streaming stops mid-response

**Error:** `STREAM_TIMEOUT` or connection closed

**Debug Steps:**
1. Check ALB timeout (should be 900s)
2. Verify ECS task isn't being killed
3. Check provider status
4. Review CloudWatch metrics for circuit breaker

---

**Last Updated**: November 2025
**Error Tracking**: CloudWatch Logs + Metrics
**Structured Logging**: JSON format with request IDs
**Error Factory**: `/lib/error-utils.ts`
