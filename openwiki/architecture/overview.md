---
type: Architecture Overview
title: System Architecture & Design Patterns
description: Next.js 16 enterprise application with layered architecture, server actions, AI provider factory pattern, and AWS cloud-native infrastructure for K-12 AI platform.
tags: [architecture, patterns, design]
---

# System Architecture

AI Studio follows a layered architecture pattern with strict separation between presentation, application, and infrastructure concerns. The system is built on Next.js 16 App Router with server-side rendering on ECS Fargate.

## Layered Architecture

### Presentation Layer (`/app`, `/components`)

React-based UI with Server Components as the default rendering model.

- **React Server Components (RSC)** — Default for static content, data fetching
- **Client Components** — Marked with `"use client"` for interactivity
- **Shadcn UI + Tailwind CSS** — Consistent component library and styling
- **React Hook Form** — Form handling with Zod validation

Key locations:
- `/app/(protected)/*` — Authenticated pages (Nexus, Admin, Atrium)
- `/app/(public)/*` — Public pages
- `/components` — Reusable UI components

### Application Layer (`/actions`)

Server actions encapsulate business logic with consistent error handling and logging.

All server actions return an `ActionState<T>` pattern:

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

Key patterns:
- Request ID tracking for distributed tracing
- Comprehensive logging via `/lib/logger`
- Type-safe input validation with Zod

### Infrastructure Layer (`/lib`)

Core utilities and adapters for external services.

| Module | Purpose |
|--------|---------|
| `/lib/db` | Drizzle ORM client with connection pooling |
| `/lib/auth` | Authentication utilities, session management |
| `/lib/ai` | AI provider factory, model configuration |
| `/lib/streaming` | SSE streaming with circuit breaker |
| `/lib/aws` | S3, CloudWatch, Secrets Manager clients |

## Key Design Patterns

### 1. Provider Factory Pattern

Unified interface for multiple AI providers through `/lib/streaming/nexus-provider-factory.ts`:

```typescript
createProviderModel(provider: string, modelId: string): Promise<LanguageModel>
```

Supported providers:
- OpenAI (GPT-5, GPT-4)
- Google (Gemini models)
- Amazon Bedrock (Claude, Llama)
- Azure OpenAI

### 2. Settings Management

Database-first configuration with environment variable fallback:

```typescript
// Check database → Fall back to env → Cache result (5-min TTL)
await getSetting('OPENAI_API_KEY')
```

Settings are stored in the `settings` table with per-deployment overrides.

### 3. Request Tracing

Every operation gets a unique request ID for observability:

```typescript
const requestId = generateRequestId()
const log = createLogger({ requestId, action: "actionName" })
```

Request IDs flow through server actions, API routes, and external service calls.

### 4. Streaming Architecture

Server-Sent Events (SSE) for real-time AI responses with:
- Circuit breaker pattern for provider failures
- Automatic failover between providers
- Token usage tracking and cost optimization

See `/lib/streaming/README.md` for detailed streaming documentation.

## Authentication & Authorization

### Cognito + Google OAuth Flow

```
User → Google OAuth → Cognito → JWT Token → NextAuth v5 → Session
```

1. User authenticates via Google SSO
2. Cognito validates domain (`hd=psd401.net`)
3. NextAuth manages JWT sessions (15min access, 24hr refresh)
4. RBAC enforced via roles and capabilities

### Role-Based Access Control

| Role | Access Level |
|------|--------------|
| Admin | Full system access, user management, infrastructure |
| Staff | Nexus, Assistant Architect, Atrium authoring |
| Student | Limited Nexus access (configurable per deployment) |

Capability definitions in `/lib/capabilities/manifest.ts` are synced to the `capabilities` table.

### API Authentication

- **API Keys** — External API access with `sk-` prefix tokens
- **Scopes** — Fine-grained permissions (e.g., `assistants:read`, `decisions:execute`)
- **OAuth2/OIDC** — External application authentication via provider at `/oauth`

See [api-integration/overview.md](../api-integration/overview.md) for authentication flows.

## K-12 Safety Features

### Content Filtering

Amazon Bedrock Guardrails wraps all AI interactions:
- Blocks violence, hate speech, sexual content
- Input and output filtering
- PII detection and tokenization before provider requests

### PII Protection

Automatically detects and tokenizes:
- Student names, emails, phone numbers
- Location data
- Identifiable information

See `/docs/features/k12-content-safety.md` for implementation details.

## Request Flow Example

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│ Client (React)  │────▶│  Server      │────▶│  AWS Cognito    │
│                 │     │  Action      │     │  + Google       │
└─────────────────┘     └──────────────┘     └─────────────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
        ┌──────────────┐            ┌──────────────┐
        │ AI Providers │            │ Drizzle ORM  │
        │ (Factory)    │            │ (postgres)   │
        └──────────────┘            └──────────────┘
                │                             │
                ▼                             ▼
    ┌───────────────────────┐      ┌──────────────────┐
    │ OpenAI/Google/Bedrock │      │ Aurora Serverless│
    │ Azure APIs            │      │ v2 (PostgreSQL)  │
    └───────────────────────┘      └──────────────────┘
```

## Related Concepts

- **[infrastructure/overview.md](../infrastructure/overview.md)** — AWS CDK infrastructure, deployment
- **[data-models/overview.md](../data-models/overview.md)** — Database schema and migrations
- **[app-features/overview.md](../app-features/overview.md)** — Application feature architecture
