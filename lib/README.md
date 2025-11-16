# Library (`/lib`) Directory

Core utilities, adapters, and business logic for AI Studio application.

## Directory Structure

```
/lib
├── ai/                   # AI provider integration
├── assistant-architect/  # Multi-prompt chain execution
├── auth/                 # Authentication & session management
├── aws/                  # AWS service adapters
├── compare/              # Model comparison logic
├── db/                   # Database access layer
├── hooks/                # React hooks
├── monitoring/           # Observability & metrics
├── nexus/                # Nexus chat features
├── prompt-library/       # Prompt templates
├── repositories/         # Knowledge repository management
├── services/             # Business services
├── stores/               # Client-side state (Zustand)
├── streaming/            # SSE streaming infrastructure
├── tools/                # AI tool definitions
├── utils/                # Shared utilities
└── validations/          # Input validation schemas
```

## Purpose

The `/lib` directory contains:
- **Adapters**: Interfaces to external services (AWS, AI providers)
- **Business Logic**: Core application features
- **Utilities**: Shared functions used across the app
- **Infrastructure**: Logging, monitoring, error handling

## Key Directories

### `/lib/streaming`
**Unified streaming service for all AI interactions**
- Provider adapters (OpenAI, Claude, Gemini, Bedrock)
- Circuit breaker pattern
- SSE event parsing
- See: `/docs/diagrams/09-streaming-architecture.md`

### `/lib/db`
**Database access layer using RDS Data API**
- SQL query execution with parameter binding
- Field transformation (snake_case ↔ camelCase)
- Connection pooling not needed (Data API handles it)
- See: `/lib/db/README.md`

### `/lib/auth`
**Authentication & authorization**
- NextAuth v5 configuration
- Server session management
- Tool access control
- See: `/docs/diagrams/05-authentication-flow.md`

### `/lib/assistant-architect`
**Multi-prompt chain execution**
- Variable substitution
- Knowledge injection
- Tool integration
- See: `/docs/diagrams/07-assistant-architect-execution.md`

### `/lib/repositories`
**Knowledge repository management**
- Document processing
- Vector search with pgvector
- Embedding generation
- See: `/docs/diagrams/08-document-processing-pipeline.md`

## Import Patterns

### Absolute Imports
All imports use `@/lib/...` path alias:

```typescript
import { createLogger } from '@/lib/logger';
import { executeSQL } from '@/lib/db/data-api-adapter';
import { getServerSession } from '@/lib/auth/server-session';
```

### Barrel Exports
Major directories export via index files:

```typescript
// Instead of
import { ErrorFactories } from '@/lib/error-utils/error-factories';

// Use
import { ErrorFactories } from '@/lib/error-utils';
```

## Common Utilities

### Logging
```typescript
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

const requestId = generateRequestId();
const timer = startTimer('operation-name');
const log = createLogger({ requestId, module: 'my-module' });

log.info('Operation started', { data });
timer({ status: 'success' });
```

### Error Handling
```typescript
import { ErrorFactories, handleError, createSuccess } from '@/lib/error-utils';

try {
  const result = await doSomething();
  return createSuccess(result, 'Success message');
} catch (error) {
  return handleError(error, 'User-friendly message', { context: 'myFunction' });
}
```

### Database Access
```typescript
import { executeSQL } from '@/lib/db/data-api-adapter';

const results = await executeSQL<UserType>(
  'SELECT * FROM users WHERE id = :id',
  [{ name: 'id', value: { longValue: userId } }]
);
```

### Field Transformation
```typescript
import { transformSnakeToCamel } from '@/lib/db/field-mapper';

// DB returns snake_case, app uses camelCase
const dbRow = { user_id: 1, created_at: '2025-01-01' };
const appData = transformSnakeToCamel<UserType>(dbRow);
// Result: { userId: 1, createdAt: '2025-01-01' }
```

## Best Practices

1. **Never use `any` types** - Full TypeScript strict mode
2. **Use structured logging** - Always include request ID and context
3. **Parameterized queries** - Never string concatenation for SQL
4. **Error factories** - Use ErrorFactories instead of throwing raw errors
5. **Field mapping** - Always transform DB results to camelCase

## Related Documentation

- [Architecture Overview](/docs/ARCHITECTURE.md)
- [API Reference](/docs/API_REFERENCE.md)
- [Error Reference](/docs/ERROR_REFERENCE.md)
- [Database ERD](/docs/diagrams/04-database-erd.md)

---

**Last Updated**: November 2025
**Import Alias**: `@/lib/*`
**Type Safety**: Full TypeScript strict mode
**Total Directories**: 17
