# Architecture

AI Studio is a Next.js 16 enterprise application built with modern cloud-native architecture principles. It provides AI-powered tools with role-based access control, featuring multiple LLM providers, document processing, and knowledge management capabilities.

## Technology Stack

### Core Framework
- **Frontend**: Next.js 16 with App Router, React 19
- **UI Components**: Shadcn UI + Tailwind CSS
- **TypeScript**: Strict type safety across the application

### AI & Machine Learning
- **AI SDK**: Vercel AI SDK v6 for LLM integration
- **Providers**: OpenAI, Google AI (Gemini), Amazon Bedrock (Claude, Llama), Azure OpenAI
- **Streaming**: Server-Sent Events (SSE) for real-time responses
- **Embeddings**: Vector search via pgvector

### Authentication & Security
- **Auth Provider**: AWS Cognito with Google OAuth federation
- **Session Management**: NextAuth v5 with JWT strategy
- **RBAC**: Role-based access control with tool-specific permissions

### Data Layer
- **Database**: AWS Aurora Serverless v2 (PostgreSQL)
- **ORM**: Drizzle ORM with postgres.js driver
- **Migrations**: Lambda-based execution via RDS Data API

### Infrastructure
- **IaC**: AWS CDK (TypeScript)
- **Hosting**: AWS ECS Fargate with Application Load Balancer
- **Storage**: S3 with lifecycle policies
- **Monitoring**: CloudWatch with structured logging + ADOT

## Layered Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  PRESENTATION LAYER                      │
│         /app, /components                                │
│   React Server Components, Client Components             │
│   Shadcn UI, Tailwind CSS, react-hook-form               │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                  APPLICATION LAYER                       │
│         /app/actions, /lib/services                      │
│   Server Actions return ActionState<T>                   │
│   Business logic isolation, Request ID tracking          │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                  INFRASTRUCTURE LAYER                    │
│         /lib/db, /lib/auth, /lib/ai, /lib/aws            │
│   Database adapter, Auth utilities, AI provider factory  │
│   AWS service clients, Settings management               │
└─────────────────────────────────────────────────────────┘
```

### Presentation Layer (`/app`, `/components`)
- React Server Components (default)
- Client components with `"use client"` directive
- Shadcn UI components with Tailwind CSS
- Form handling with react-hook-form

### Application Layer (`/app/actions`, `/lib/services`)
- Server actions return `ActionState<T>` pattern
- Business logic isolation
- Request ID tracking for tracing
- Comprehensive logging and error handling

### Infrastructure Layer (`/lib`)
- Database adapter (`/lib/db`)
- Authentication utilities (`/lib/auth`)
- AI provider factory (`/lib/ai`)
- AWS service clients (S3, CloudWatch)
- Settings management with caching

## Key Design Patterns

### 1. ActionState Pattern

All server actions return a consistent response structure:

```typescript
interface ActionState<T> {
  isSuccess: boolean
  data?: T
  error?: {
    code: string
    message: string
    details?: unknown
  }
  message?: string
}
```

### 2. Provider Factory Pattern

Unified interface for multiple AI providers:

```typescript
// lib/ai/provider-factory.ts
createProviderModel(provider: string, modelId: string): Promise<LanguageModel>
```

Supported providers: `openai`, `amazon-bedrock`, `google`, `azure`

### 3. Request Tracing

Every operation gets a unique request ID:

```typescript
const requestId = generateRequestId()
const log = createLogger({ requestId, action: "actionName" })
```

### 4. Settings Management

Database-first configuration with environment fallback:

```typescript
// Check database → Fall back to env → Cache result
await getSetting('OPENAI_API_KEY')
```

## Directory Structure

```
/app/
├── (protected)/          # Auth-required routes
│   ├── admin/           # Admin panel
│   ├── nexus/           # Nexus chat
│   ├── atrium/          # Atrium content workspace
│   ├── tools/           # Assistant Architect
│   └── repositories/    # Knowledge repositories
├── (public)/            # Public routes
├── api/                 # API routes
│   ├── v1/             # REST API v1
│   ├── nexus/          # Nexus chat API
│   └── mcp/            # MCP server endpoints
└── actions/            # Server actions

/lib/
├── ai/                  # AI provider factory
├── auth/                # Authentication utilities
├── content/             # Atrium content services
├── db/                  # Drizzle ORM
│   ├── schema/         # Database schema (80+ tables)
│   └── drizzle/        # Query helpers
├── nexus/               # Nexus chat logic
├── safety/              # Content safety, PII
├── streaming/           # SSE streaming
└── tools/               # AI tool definitions

/infra/
├── lib/                 # CDK stack definitions
├── database/            # Migrations
└── agent-image/         # Agent platform Docker
```

## Database Schema Overview

### Core Tables (80+ tables total)

**Users & Auth**
- `users` - User accounts linked to Cognito
- `roles` - Available roles (student, staff, administrator)
- `user_roles` - User-role associations
- `capabilities` - Role-gated UI feature registry

**Content (Atrium)**
- `content_objects` - Documents and artifacts
- `content_versions` - Immutable version snapshots
- `content_publications` - Publish records by destination
- `content_visibility_grants` - Permission grants

**Nexus Chat**
- `nexus_conversations` - Chat conversations
- `nexus_messages` - Chat messages
- `nexus_mcp_connections` - MCP server connections

**Knowledge**
- `knowledge_repositories` - Knowledge bases
- `repository_items` - Documents in repositories
- `repository_item_chunks` - Vector-indexed chunks

## Request Flow

```
Client Request
     │
     ▼
┌─────────────────┐
│   middleware.ts │ Route protection, security headers
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Route Handler  │ App Router page or API route
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐  ┌────────┐
│Action │  │Service │ Business logic
└───┬───┘  └───┬────┘
    │          │
    └────┬─────┘
         ▼
┌─────────────────┐
│  Drizzle ORM    │ Type-safe DB queries
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Aurora Serverless│ PostgreSQL with pgvector
└─────────────────┘
```

## Source References

| Component | Primary Files |
|-----------|---------------|
| App Entry | `/app/layout.tsx`, `/server.ts` |
| Middleware | `/middleware.ts` |
| Auth Config | `/auth.ts` |
| DB Client | `/lib/db/drizzle-client.ts` |
| Provider Factory | `/lib/ai/provider-factory.ts` |
| Streaming | `/lib/streaming/unified-streaming-service.ts` |
| Settings | `/lib/settings-manager.ts` |
| Logger | `/lib/logger.ts` |
| Error Utils | `/lib/error-utils.ts` |

For detailed architecture diagrams, see [docs/diagrams/](../docs/diagrams/).
