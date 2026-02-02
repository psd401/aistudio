# CLAUDE.md

AI Studio codebase guidance for Claude Code. Optimized for token efficiency and accuracy.

## 🚀 Quick Reference

```bash
# Local Development (Issue #607)
npm run db:up              # Start local PostgreSQL (Docker)
npm run dev:local          # Run Next.js with local database
npm run db:studio          # Open Drizzle Studio to inspect DB
npm run db:psql            # Connect to local DB via psql
npm run db:seed            # Create test users (admin/staff/student)
npm run db:reset           # Reset database (destroys all data)

# Development (without Docker)
npm run dev                # Start dev server (port 3000)
npm run build              # Build for production
npm run lint               # MUST pass before commit
npm run typecheck          # MUST pass before commit
npm run test:e2e           # Run E2E tests

# Infrastructure (from /infra)
cd infra && npx cdk deploy --all                          # Deploy all stacks
cd infra && npx cdk deploy AIStudio-FrontendStack-Dev     # Deploy single stack
```

## 🎯 Critical Rules

1. **Type Safety**: NO `any` types. Full TypeScript. Run `npm run lint` and `npm run typecheck` on ENTIRE codebase before commits.
2. **Database Migrations**: Files 001-005 are IMMUTABLE. Only add migrations 010+. Add filename to `MIGRATION_FILES` array in `/infra/database/lambda/db-init-handler.ts`.
3. **Logging**: NEVER use `console.log/error`. Always use `@/lib/logger`. See patterns below.
4. **Git Flow**: PRs target `dev` branch, never `main`. Write detailed commit messages.
5. **Testing**: Add E2E tests for new features. Use Playwright MCP during development.
6. **Nexus Conversations**: MUST read `/docs/features/nexus-conversation-architecture.md` before modifying conversation code. This system has broken multiple times - follow documented patterns exactly.
7. **API Documentation**: When adding or modifying `/api/v1/` endpoints, update both `docs/API/v1/openapi.yaml` (OpenAPI spec) and `docs/API/v1/context-graph.md` (human-readable reference). Include request/response examples, error codes, and auth/scope requirements.

## 🏗️ Architecture

**Stack**: Next.js 15 App Router • ECS Fargate (SSR) • Aurora Serverless v2 • Cognito Auth

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

**Supported**: PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, JSON, XML, YAML (via `/lib/document-processing.ts` and `/lib/nexus/enhanced-attachment-adapters.ts`)
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
npm run drizzle:generate        # Generate from schema changes
npm run migration:prepare       # Format for Lambda
npm run migration:list          # List all migrations
# Then add to MIGRATION_FILES in db-init-handler.ts
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
- Graceful shutdown: Handled automatically via `instrumentation.ts`
- Connection warmup: Pools are pre-initialized on server startup

**Local Development Setup** (Issue #607):
```bash
# Quick Start (first time)
npm run db:up              # Start PostgreSQL container
npm run db:seed            # Create test users
npm run dev:local          # Start Next.js with local DB

# Daily workflow
npm run db:up && npm run dev:local   # Start everything

# Reset if database gets corrupted
npm run db:reset           # Destroys all data, re-runs migrations
npm run db:seed            # Re-create test users
```

**Local vs AWS Configuration**:
| Environment | DATABASE_URL | DB_SSL |
|-------------|--------------|--------|
| Local Docker | `postgresql://postgres:postgres@localhost:5432/aistudio` | `false` |
| AWS Aurora | `postgresql://user:pass@aurora-cluster:5432/aistudio` | `true` (default) |

**Test Users** (after `npm run db:seed`):
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

## 🧪 Testing

**E2E Testing**:
- Development: Use Playwright MCP (`/e2e-test` command)
- CI/CD: Add to `/tests/e2e/working-tests.spec.ts`
- Documentation: Update `/tests/e2e/playwright-mcp-examples.md`

## 🏗️ Infrastructure Patterns

### VPC & Networking
**Shared VPC Architecture** (consolidated from 2 VPCs to 1):
- All stacks use `VPCProvider.getOrCreate()` for consistent networking
- DatabaseStack creates VPC, other stacks import via `Vpc.fromLookup()`
- **Subnets**: Public, Private-Application, Private-Data, Isolated
- **VPC Endpoints**: S3, DynamoDB (gateway), plus 14+ interface endpoints
- **NAT Gateways**: Managed NAT gateways in all environments
- See `/infra/lib/constructs/network/` for patterns

```typescript
import { VPCProvider } from './constructs/network'

const vpc = VPCProvider.getOrCreate(this, environment, config)
// Automatically handles VPC creation vs. import based on stack
```

### Lambda Optimization
**PowerTuning Results** (use these defaults):
- **Standard functions**: 1024 MB (66% reduction from previous 3GB)
- **Memory-intensive**: 2048 MB
- **Lightweight**: 512 MB
- All functions use **Node.js 20.x** runtime
- X-Ray tracing enabled for observability

**Lambda Best Practices**:
- Always use `ServiceRoleFactory` for IAM roles
- Enable VPC only when accessing RDS/ElastiCache
- Use environment variables for configuration
- Add CloudWatch Logs retention (7 days dev, 30 days prod)

### ECS Fargate Optimization
- **Non-critical workloads**: Fargate Spot (70% cost savings)
- **Production frontend**: Fargate on-demand with auto-scaling
- **Task sizing**: Right-sized via load testing
- **Graviton2**: Not yet enabled (future optimization)

### Monitoring & Observability
**Consolidated Monitoring** (see `/infra/lib/constructs/monitoring/`):
- **AWS Distro for OpenTelemetry (ADOT)** for distributed tracing
- **Unified CloudWatch Dashboard** with 115+ widgets across all services
- **Metrics tracked**: Lambda performance, ECS health, RDS metrics, API latency
- **Alarms**: Configured for critical thresholds (errors, latency, resource utilization)

**Access Dashboards**:
- AWS Console → CloudWatch → Dashboards → "AIStudio-Consolidated-[Environment]"

**Custom Metrics** (add via ADOT):
```typescript
// In Lambda/ECS code
import { metrics } from '@aws-lambda-powertools/metrics'

metrics.addMetric('customMetric', 'Count', 1)
```

### Cost Optimization Patterns
**Implemented Optimizations**:
1. **Aurora Serverless**: Auto-pause in dev (saves ~$44/month)
2. **ECS Spot**: 70% savings on non-critical workloads
3. **Lambda Right-Sizing**: 66% memory reduction via PowerTuning
4. **S3 Lifecycle**: Intelligent-Tiering + automatic archival
5. **VPC Endpoints**: Reduces NAT gateway data transfer costs

**Cost Monitoring**:
- AWS Cost Explorer: Track by service and environment tags
- Budget alerts configured for each environment
- Monthly cost reports automated via CloudWatch Events

## 🔒 Security & IAM

### Application Security
- Routes under `/(protected)` require authentication
- Role-based access via `hasToolAccess("tool-name")` - checks if user has permission
- Parameterized queries prevent SQL injection
- All secrets in AWS Secrets Manager with automatic rotation
- `sanitizeForLogging()` for PII protection

### Infrastructure Security (IAM Least Privilege)
**CRITICAL**: All new Lambda/ECS roles MUST use `ServiceRoleFactory`:

```typescript
import { ServiceRoleFactory } from './constructs/security'

const role = ServiceRoleFactory.createLambdaRole(this, 'MyFunctionRole', {
  functionName: 'my-function',
  environment: props.environment,  // REQUIRED for tag-based access
  region: this.region,
  account: this.account,
  vpcEnabled: false,
  s3Buckets: ['bucket-name'],           // Auto-scoped with tags
  dynamodbTables: ['table-name'],       // Auto-scoped with tags
  sqsQueues: ['queue-arn'],             // Auto-scoped with tags
  secrets: ['secret-arn'],              // Auto-scoped with tags
})
```

**Tag-Based Access Control** (Enforced):
- All AWS resources MUST have tags: `Environment` (dev/staging/prod), `ManagedBy` (cdk)
- IAM policies enforce tag-based conditions (dev Lambda cannot access prod S3)
- Cross-environment access is blocked at IAM level
- See `/infra/lib/constructs/security/service-role-factory.ts` for patterns

**Secrets Management**:
- All secrets stored in AWS Secrets Manager (never hardcoded)
- Access via `SecretsManagerClient` from AWS SDK
- Secrets scoped by environment tags
- Automatic rotation enabled where supported

## 📦 Key Dependencies

- Vercel AI SDK v6 (`ai`, `@ai-sdk/react`, `@ai-sdk/*` providers)
- Next.js 16 App Router
- NextAuth v5
- AWS SDK v3 clients

## 🚨 Common Pitfalls

### Code Quality
- **Don't** use `any` types - full TypeScript strict mode required
- **Don't** use console methods - use `@/lib/logger` instead
- **Don't** skip type checking - entire codebase must pass
- **Don't** commit without running lint and typecheck

### Git & Deployment
- **Don't** create PRs against `main` - always use `dev`
- **Don't** modify files 001-005 in `/infra/database/schema/` (immutable migrations)

### Infrastructure
- **Don't** create Lambda/ECS roles manually - use `ServiceRoleFactory`
- **Don't** create resources without `Environment` and `ManagedBy` tags
- **Don't** use `Vpc.fromVpcAttributes` - use `VPCProvider.getOrCreate()`
- **Don't** hardcode secrets - use AWS Secrets Manager
- **Don't** trust app code for DB schema - use MCP tools
- **Don't** deploy infrastructure without running `npx cdk synth` first

### Security
- **Don't** grant `resources: ['*']` in IAM policies (except where AWS requires it)
- **Don't** allow cross-environment access (dev → prod blocked by tags)
- **Don't** skip tag-based conditions in custom IAM policies

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

---
*Token-optimized for Claude Code efficiency. Last updated: January 2025*
*Infrastructure optimized via Epic #372 - AWS Well-Architected Framework aligned*