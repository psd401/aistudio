# Agent reference: architecture, database and server-action patterns

Reference material moved out of the root `AGENTS.md` so that file stays under
200 lines (psd-dev-standards standards/02, "Context files"). The rules agents
must follow, the commands and the "Don't" list are in
[AGENTS.md](../../AGENTS.md); this page holds the patterns and detail behind
them.

## Architecture

**Stack**: Next.js 16 App Router • ECS Fargate (SSR) • Aurora Serverless v2 • Cognito Auth

**Core Patterns**:
- Server Actions return `ActionState<T>`
- Drizzle ORM for all DB operations (executeQuery/executeTransaction)
- JWT sessions via NextAuth v5
- Layered architecture (presentation → application → infrastructure)
- **Reusable CDK constructs** for infrastructure consistency

**File Structure**:
```
/app         → Pages & API routes
/actions     → Server actions (*.actions.ts)
/components  → UI components
/lib         → Core utilities & adapters
/infra       → AWS CDK infrastructure
  ├── lib/constructs/        → Reusable CDK patterns
  │   ├── security/          → IAM, secrets, roles
  │   ├── network/           → VPC, shared networking
  │   ├── compute/           → Lambda, ECS patterns
  │   ├── monitoring/        → CloudWatch, ADOT
  │   └── config/            → Environment configs
  ├── lib/stacks/            → CDK stack definitions
  └── database/              → RDS, migrations
```

## 🤖 AI Integration

**AI SDK v6** with provider factory pattern:
- Providers: OpenAI, Google (Gemini), Amazon Bedrock (Claude), Azure
- Streaming: `streamText` for chat, SSE for assistant architect
- Client: `@ai-sdk/react` with `useChat` hook

**Provider Factory** (`/app/api/chat/lib/provider-factory.ts`):
```typescript
createProviderModel(provider: string, modelId: string): Promise<LanguageModel>
```

**Settings Management**:
- Database-first with env fallback via `@/lib/settings-manager`
- Cache with 5-minute TTL
- AWS Lambda IAM role support for Bedrock

## 📚 Document Processing

**Supported**: PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, JSON, XML, YAML (via `/lib/document-processing.ts` and `/lib/attachments/chat-attachment-adapters.ts`)
**Storage**: S3 with presigned URLs for large files
**Limits**: 500MB for Nexus attachments, 25MB for document processing (configurable per deployment)

## 🗄️ Database Operations

**ORM**: Drizzle ORM with postgres.js driver (direct PostgreSQL connection)

**Always use Drizzle queries** - Import from `@/lib/db/drizzle` for type-safe operations:

```typescript
import { eq, and, desc } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import { users, userRoles, roles } from "@/lib/db/schema";

// SELECT with type safety
const user = await executeQuery(
  (db) => db.select().from(users).where(eq(users.id, userId)).limit(1),
  "getUserById"
);

// INSERT with returning
const [newUser] = await executeQuery(
  (db) => db.insert(users).values({ email, firstName }).returning(),
  "createUser"
);

// UPDATE
await executeQuery(
  (db) => db.update(users).set({ firstName }).where(eq(users.id, userId)),
  "updateUser"
);

// DELETE
await executeQuery(
  (db) => db.delete(users).where(eq(users.id, userId)),
  "deleteUser"
);
```

**Transactions** (automatic rollback on error):
```typescript
await executeTransaction(
  async (tx) => {
    await tx.delete(userRoles).where(eq(userRoles.userId, userId));
    await tx.insert(userRoles).values(roleIds.map(id => ({ userId, roleId: id })));
    // Side effects (emails, etc.) should be AFTER transaction, not inside
  },
  "updateUserRoles"
);
```

**⚠️ CRITICAL - Transaction Pattern**:
- ✅ Use `executeTransaction()` directly for multi-statement transactions
- ✅ Transaction isolation levels are supported (serializable, repeatable read, etc.)
- ❌ NEVER nest `db.transaction()` inside `executeQuery()`
- See `/docs/database/drizzle-patterns.md` and `drizzle-client.ts` JSDoc

**JSONB Columns** (type-safe via `.$type<T>()`):
```typescript
import type { UserSettings } from "@/lib/db/types/jsonb";

// Schema definition
settings: jsonb("settings").$type<UserSettings>(),

// Query - TypeScript knows the shape
user.settings.theme;  // "light" | "dark" | "system"
```

**Migrations** (see `/docs/database/drizzle-migration-guide.md`):
```bash
bun run drizzle:generate        # Generate from schema changes
bun run migration:prepare       # Format for Lambda
bun run migration:list          # List all migrations
# Then add to migrationFiles array in /infra/database/migrations.json
```

**MCP tools for schema verification**:
```bash
mcp__awslabs_postgres-mcp-server__get_table_schema
mcp__awslabs_postgres-mcp-server__run_query
```

**Aurora Serverless v2 Configuration**:
- **Dev**: Auto-pause enabled (scales to 0 ACU when idle, saves ~$44/month)
- **Prod**: Min 2 ACU, Max 8 ACU, always-on for reliability
- **Connection**: postgres.js driver with connection pooling (max: 20, idle_timeout: 20s)
- **Backups**: Automated daily snapshots, 7-day retention (dev), 30-day (prod)

**Connection Management** (Issue #603):
- Use `DATABASE_URL` for local dev (set in .env.local)
- Use `DB_HOST/DB_USER/DB_PASSWORD` for ECS (auto-injected from Secrets Manager)
- Connection pool auto-manages connections (max: 20 per container)
- Bounded DB waits + wedged-pool self-heal: `DB_STATEMENT_TIMEOUT_MS` (60s dev / off prod), `DB_QUERY_DEADLINE_MS` (90s), `DB_TX_DEADLINE_MS` (300s); per-call `deadlineMs` override — see `docs/database/drizzle-patterns.md` (Timeouts section)
- Graceful shutdown: Handled automatically via `instrumentation.ts`
- Connection warmup: Pools are pre-initialized on server startup

**Local Development Setup** (Issue #607):
```bash
# Quick Start (first time)
bun run db:up              # Start PostgreSQL container
bun run db:seed            # Create test users
bun run dev:local          # Start Next.js with local DB

# Daily workflow
bun run db:up && bun run dev:local   # Start everything

# Reset if database gets corrupted
bun run db:reset           # Destroys all data, re-runs migrations
bun run db:seed            # Re-create test users
```

**Local vs AWS Configuration**:
| Environment | DATABASE_URL | DB_SSL |
|-------------|--------------|--------|
| Local Docker | `postgresql://postgres:postgres@localhost:5432/aistudio` | `false` |
| AWS Aurora | `postgresql://user:pass@aurora-cluster:5432/aistudio` | `true` (default) |

**Test Users** (after `bun run db:seed`):
- `test@example.com` - administrator role
- `staff@example.com` - staff role
- `student@example.com` - student role

**Raw SQL Results** (postgres.js driver):
```typescript
import { toPgRows, executeQuery } from "@/lib/db/drizzle-client";
import { sql } from "drizzle-orm";

// Raw SQL returns array-like object (no .rows property)
const result = await executeQuery(
  (db) => db.execute(sql`SELECT id, name FROM users WHERE active = true`),
  "getActiveUsers"
);
const users = toPgRows<{ id: number; name: string }>(result);
```

**Troubleshooting**:
- "Connection refused": Check VPC security groups allow traffic from ECS to Aurora
- "Too many connections": Increase Aurora max_connections or reduce `DB_MAX_CONNECTIONS` per task
- "SSL required": Ensure connection string includes `?sslmode=require` (auto-added by drizzle-client)
- "Connection timeout": Check `DB_CONNECT_TIMEOUT` env var (default: 10s)
- First request slow: Connection pool warmup happens on startup; check logs for "warmed up successfully"

## 📝 Server Action Template

```typescript
"use server"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { getServerSession } from "@/lib/auth/server-session"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq } from "drizzle-orm"
import { users } from "@/lib/db/schema"

export async function actionName(params: ParamsType): Promise<ActionState<ReturnType>> {
  const requestId = generateRequestId()
  const timer = startTimer("actionName")
  const log = createLogger({ requestId, action: "actionName" })

  try {
    log.info("Action started", { params: sanitizeForLogging(params) })

    // Auth check
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized")
      throw ErrorFactories.authNoSession()
    }

    // Business logic - use Drizzle ORM executeQuery
    const result = await executeQuery(
      (db) => db.select().from(users).where(eq(users.id, params.userId)),
      "actionName"
    )

    timer({ status: "success" })
    log.info("Action completed")
    return createSuccess(result, "Success message")

  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "User-friendly error", {
      context: "actionName",
      requestId,
      operation: "actionName"
    })
  }
}
```

## 📦 Key Dependencies

- Vercel AI SDK v6 (`ai`, `@ai-sdk/react`, `@ai-sdk/*` providers)
- Next.js 16 App Router
- NextAuth v5
- AWS SDK v3 clients

## 📖 Documentation

**Structure:**
```
/docs/
├── README.md           # Documentation index
├── ARCHITECTURE.md     # System architecture
├── DEPLOYMENT.md       # Deployment guide
├── guides/            # Development guides
├── features/          # Feature docs
├── operations/        # Ops & monitoring
└── archive/           # Historical docs
```

**Maintenance:**
- Keep docs current with code changes
- Archive completed implementations
- Remove outdated content
- Update index when adding docs

## 🎯 Repository Knowledge System

**Assistant Architect**: Processes repository context for AI assistants
**Embeddings**: Vector search via `/lib/repositories/search-service.ts`
**Knowledge Base**: Stored in S3, retrieved during execution

