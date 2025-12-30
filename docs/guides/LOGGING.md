# Logging Patterns Guide

Detailed logging patterns and examples for AI Studio. This document provides comprehensive templates and best practices for implementing logging throughout the application.

## Core Logging Principles

1. **Never use console methods** - ESLint will catch violations
2. **Always generate requestId** for tracing
3. **Use timers** for performance tracking
4. **Sanitize sensitive data** before logging
5. **Use structured logging** with metadata

## Import Requirements

```typescript
// Standard imports for all server-side code
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
```

## Server Action Patterns

### Basic Server Action

```typescript
"use server"

export async function myAction(params: ParamsType): Promise<ActionState<ReturnType>> {
  const requestId = generateRequestId()
  const timer = startTimer("myAction")
  const log = createLogger({ requestId, action: "myAction" })
  
  try {
    log.info("Action started", { params: sanitizeForLogging(params) })
    
    // Authentication
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized access attempt")
      throw ErrorFactories.authNoSession()
    }
    
    // Authorization
    const hasAccess = await hasToolAccess(session.user.sub, "toolName")
    if (!hasAccess) {
      log.warn("Access denied", { userId: session.user.sub, tool: "toolName" })
      throw ErrorFactories.authzToolAccessDenied("toolName")
    }
    
    // Business logic
    log.debug("Processing operation", { userId: session.user.sub })
    const result = await performOperation()
    
    // Success
    timer({ status: "success" })
    log.info("Action completed successfully", { resultCount: result.length })
    return createSuccess(result, "Operation completed successfully")
    
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to complete operation. Please try again.", {
      context: "myAction",
      requestId,
      operation: "myAction"
    })
  }
}
```

### Database Operation with Transaction

```typescript
export async function createUserWithRolesAction(
  userData: UserData
): Promise<ActionState<User>> {
  const requestId = generateRequestId()
  const timer = startTimer("createUserWithRoles")
  const log = createLogger({ requestId, action: "createUserWithRoles" })
  
  try {
    log.info("Creating user with roles", {
      email: sanitizeForLogging(userData.email),
      roleCount: userData.roles.length
    })

    const result = await executeTransaction(async (tx) => {
      log.debug("Transaction started")

      // Create user
      const [user] = await tx.insert(users).values({
        email: userData.email,
        name: userData.name
      }).returning()
      log.debug("User created", { userId: user.id })

      // Add roles
      if (userData.roles.length > 0) {
        await tx.insert(userRoles).values(
          userData.roles.map(role => ({
            userId: user.id,
            roleId: role.id
          }))
        )
      }
      log.debug("Roles assigned", { count: userData.roles.length })

      return user
    }, "createUserWithRoles")
    
    timer({ status: "success" })
    log.info("User created successfully", { userId: result.id })
    return createSuccess(result, "User created successfully")
    
  } catch (error) {
    timer({ status: "error" })
    log.error("Failed to create user", { 
      error,
      email: sanitizeForLogging(userData.email) 
    })
    return handleError(error, "Failed to create user. Please check the data and try again.", {
      context: "createUserWithRoles",
      requestId
    })
  }
}
```

## API Route Patterns

### GET Endpoint

```typescript
import { NextRequest, NextResponse } from "next/server"
import { withErrorHandling } from "@/lib/error-utils"

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const requestId = generateRequestId()
  const timer = startTimer("GET /api/users/[id]")
  const log = createLogger({ requestId, route: "/api/users/[id]" })
  
  return withErrorHandling(async () => {
    log.info("GET request received", { 
      userId: params.id,
      query: Object.fromEntries(request.nextUrl.searchParams)
    })
    
    // Validate input
    if (!params.id || isNaN(Number(params.id))) {
      log.warn("Invalid user ID", { id: params.id })
      return NextResponse.json(
        { error: "Invalid user ID" },
        { status: 400 }
      )
    }
    
    // Fetch data
    const user = await getUserById(Number(params.id))
    if (!user) {
      log.info("User not found", { userId: params.id })
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      )
    }
    
    timer({ status: "success" })
    log.info("User retrieved successfully")
    return NextResponse.json(user)
  })
}
```

### POST Endpoint with Streaming

```typescript
export async function POST(request: Request) {
  const requestId = generateRequestId()
  const timer = startTimer("POST /api/chat")
  const log = createLogger({ requestId, route: "/api/chat" })
  
  try {
    const body = await request.json()
    log.info("Chat request received", {
      messageCount: body.messages?.length,
      modelId: body.modelId
    })
    
    // Authenticate
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized chat attempt")
      return new Response("Unauthorized", { status: 401 })
    }
    
    // Stream response
    log.debug("Starting stream", { userId: session.sub })
    const stream = await streamText({
      model: await createProviderModel(body.provider, body.modelId),
      messages: body.messages,
      onFinish: ({ text, usage }) => {
        timer({ status: "success", tokens: usage.totalTokens })
        log.info("Stream completed", { 
          totalTokens: usage.totalTokens,
          responseLength: text.length 
        })
      }
    })
    
    return stream.toResponse()
    
  } catch (error) {
    timer({ status: "error" })
    log.error("Chat request failed", { error })
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
}
```

## Error Handling Patterns

### Using Error Factories

```typescript
// Validation errors
if (!email || !email.includes("@")) {
  log.warn("Invalid email format", { email: sanitizeForLogging(email) })
  throw ErrorFactories.validationFailed([
    { field: "email", message: "Invalid email format" }
  ])
}

// Database errors
try {
  const result = await executeQuery(
    (db) => db.select().from(users).where(eq(users.id, userId)),
    "getUser"
  )
} catch (dbError) {
  log.error("Database query failed", { error: dbError })
  throw ErrorFactories.databaseError(dbError)
}

// Authorization errors
if (!userRoles.includes("admin")) {
  log.warn("Insufficient permissions", { 
    required: "admin", 
    actual: userRoles 
  })
  throw ErrorFactories.authzInsufficientPermissions("admin", userRoles)
}

// Configuration errors
if (!apiKey) {
  log.error("API key not configured")
  throw ErrorFactories.sysConfigurationError("OpenAI API key not configured")
}
```

## Performance Tracking

### Timer Usage Patterns

```typescript
// Basic timer
const timer = startTimer("operationName")
// ... perform operation ...
timer({ status: "success" })

// Timer with metadata
const timer = startTimer("batchProcess")
const results = await processBatch(items)
timer({ 
  status: "success", 
  itemCount: items.length,
  successCount: results.filter(r => r.success).length,
  duration: Date.now() - startTime 
})

// Nested timers for detailed tracking
const mainTimer = startTimer("complexOperation")
const dbTimer = startTimer("databaseQuery")
const dbResult = await executeQuery(
  (db) => db.select().from(users),
  "getAllUsers"
)
dbTimer({ status: "success", rows: dbResult.length })

const apiTimer = startTimer("externalAPI")
const apiResult = await callExternalAPI()
apiTimer({ status: "success", responseTime: apiResult.duration })

mainTimer({ status: "success", totalOperations: 2 })
```

## Log Levels Guide

### Debug Level
```typescript
log.debug("Detailed operation info", {
  step: "validation",
  inputSize: data.length,
  processingMode: "batch"
})
```

### Info Level
```typescript
log.info("Important business event", {
  action: "userCreated",
  userId: user.id,
  email: sanitizeForLogging(user.email)
})
```

### Warning Level
```typescript
log.warn("Potential issue detected", {
  issue: "rateLimitApproaching",
  current: 95,
  limit: 100,
  userId: session.user.sub
})
```

### Error Level (handled by error-utils)
```typescript
// Errors are logged automatically by handleError()
// Manual error logging only for special cases:
log.error("Critical operation failed", {
  operation: "paymentProcessing",
  transactionId: tx.id,
  error: error.message,
  stack: error.stack
})
```

## Sensitive Data Handling

### Using sanitizeForLogging

```typescript
// Automatic PII masking
log.info("User login", {
  email: sanitizeForLogging(email),  // becomes ***@domain.com
  password: sanitizeForLogging(password),  // becomes [REDACTED]
  apiKey: sanitizeForLogging(apiKey),  // becomes [REDACTED]
})

// Safe logging of objects
const sanitizedUser = sanitizeForLogging({
  id: 123,
  email: "user@example.com",
  password: "secret123",
  creditCard: "4111-1111-1111-1111"
})
// Results in: { id: 123, email: "***@example.com", password: "[REDACTED]", creditCard: "[REDACTED]" }
```

## CloudWatch Integration

### Structured Log Format

All logs are automatically formatted for CloudWatch:

```json
{
  "timestamp": "2025-08-19T10:00:00Z",
  "level": "info",
  "requestId": "req_abc123xyz",
  "userId": "user-456",
  "action": "createDocument",
  "message": "Document created successfully",
  "metadata": {
    "documentId": "doc-789",
    "size": 2048,
    "type": "pdf"
  },
  "duration": 1234
}
```

### Querying Logs in CloudWatch

```sql
-- Find all errors for a specific request
fields @timestamp, message, error
| filter requestId = "req_abc123xyz"
| filter level = "error"
| sort @timestamp desc

-- Track slow operations
fields @timestamp, action, duration
| filter duration > 5000
| stats avg(duration) by action

-- Monitor specific user activity
fields @timestamp, action, message
| filter userId = "user-456"
| sort @timestamp desc
| limit 100
```

## Testing Logging

### Unit Test Example

```typescript
import { createLogger } from "@/lib/logger"

jest.mock("@/lib/logger", () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })),
  generateRequestId: () => "test-request-id",
  startTimer: () => jest.fn(),
  sanitizeForLogging: (data: unknown) => data
}))

test("should log action start and completion", async () => {
  const mockLogger = createLogger({})
  
  await myAction({ test: "data" })
  
  expect(mockLogger.info).toHaveBeenCalledWith(
    "Action started",
    expect.objectContaining({ params: { test: "data" } })
  )
  expect(mockLogger.info).toHaveBeenCalledWith(
    "Action completed successfully"
  )
})
```

## Common Anti-Patterns to Avoid

```typescript
// ❌ BAD - Using console
console.log("Debug info")
console.error("Error occurred")

// ❌ BAD - Generic error messages
throw new Error("Error")
return { error: "Something went wrong" }

// ❌ BAD - Logging sensitive data
log.info("User data", { password: user.password })
log.debug("API call", { apiKey: process.env.API_KEY })

// ❌ BAD - No request tracing
export async function action() {
  // Missing requestId generation
  const result = await doWork()
  return result
}

// ❌ BAD - No performance tracking
export async function slowAction() {
  // Missing timer
  await heavyOperation()
  return result
}

// ✅ GOOD - Proper patterns
const requestId = generateRequestId()
const timer = startTimer("action")
const log = createLogger({ requestId, action: "action" })
log.info("Starting", { params: sanitizeForLogging(params) })
// ... work ...
timer({ status: "success" })
```

## Environment-Specific Logging

### Development
- All log levels visible
- Formatted for terminal readability
- Stack traces included

### Production
- Debug logs suppressed
- JSON format for CloudWatch
- Performance metrics included
- PII automatically redacted

### Testing
- Mocked logger for unit tests
- Assertions on log calls
- No actual log output

---

*For questions about logging patterns, check the error-utils.ts and logger.ts source files.*