# AI Studio - OpenWiki Quickstart

AI Studio is an open-source platform that brings frontier AI to K-12 education—securely, affordably, and responsibly. It provides educators and students access to GPT-5, Claude, and Gemini models at 90% lower cost than individual licenses, deployed within district infrastructure for data privacy.

## Repository Overview

| Aspect | Details |
|--------|---------|
| **Tech Stack** | Next.js 16, React 19, TypeScript, Tailwind CSS |
| **Database** | Aurora Serverless v2 (PostgreSQL) with Drizzle ORM |
| **Auth** | AWS Cognito + Google SSO via NextAuth v5 |
| **Infrastructure** | AWS CDK, ECS Fargate, S3, CloudWatch |
| **AI Providers** | OpenAI, Amazon Bedrock (Claude/Llama), Google Gemini, Azure OpenAI |
| **Package Manager** | Bun |

### Core Features

- **Nexus Chat** - Conversational AI with multiple models, tool integration, and MCP support
- **Assistant Architect** - No-code custom AI assistant builder with prompt chains and scheduling
- **Knowledge Repositories** - Document upload, OCR, vector embeddings for semantic search
- **Atrium** - Agent-native content workspace for collaborative document/artifact creation
- **Model Compare** - Side-by-side model evaluation with cost analysis
- **API v1** - REST API for external integrations with API key and OAuth support

## Quick Start Commands

```bash
# Local development (Issue #607)
bun run db:up              # Start local PostgreSQL (Docker)
bun run dev:local          # Run Next.js with local database
bun run db:studio          # Open Drizzle Studio to inspect DB
bun run db:seed            # Create test users (admin/staff/student)

# Development (without Docker)
bun run dev                # Start dev server (port 3000)
bun run build              # Build for production
bun run lint               # MUST pass before commit
bun run typecheck          # MUST pass before commit

# Testing
bun run test               # Unit tests (Jest)
bun run test:e2e           # E2E tests (Playwright)
bun run test:smoke:atrium  # Smoke tests for Atrium

# Infrastructure
cd infra && bunx cdk deploy --all  # Deploy all stacks
```

## Critical Rules

1. **Type Safety**: No `any` types. Run `bun run lint` and `bun run typecheck` before commits.
2. **Database Migrations**: Files 001-005 are IMMUTABLE. Add migrations 010+. Update `migrationFiles` in `/infra/database/migrations.json`.
3. **Logging**: NEVER use `console.log/error`. Use `@/lib/logger`. Exception: standalone CJS scripts outside Next.js runtime.
4. **Git Flow**: PRs target `dev` branch, never `main`. Write detailed commit messages.
5. **Nexus Conversations**: Read `/docs/features/nexus-conversation-architecture.md` before modifying conversation code.
6. **API Documentation**: Update `docs/API/v1/openapi.yaml` and `docs/API/v1/context-graph.md` when modifying `/api/v1/` endpoints.

## Documentation Sections

- [Architecture](architecture.md) - Technology stack, layered architecture, design patterns
- [Authentication & Security](authentication.md) - Auth flow, RBAC, API keys, K-12 content safety
- [AI Providers & Streaming](ai-providers.md) - Multi-provider support, streaming, tools, MCP
- [Content System (Atrium)](content-system.md) - Documents, artifacts, versioning, publishing
- [Infrastructure](infrastructure.md) - CDK stacks, deployments, agent platform
- [Testing](testing.md) - Unit, E2E, and smoke test guidance

## Directory Structure

```
/
├── app/                    # Next.js App Router
│   ├── (protected)/        # Auth-required routes (admin, nexus, atrium, etc.)
│   ├── (public)/           # Public routes
│   ├── api/                # API routes (v1, nexus, mcp, etc.)
│   └── actions/            # Server actions
├── components/             # React components
│   ├── ui/                 # Shadcn UI components
│   ├── nexus/              # Nexus chat components
│   ├── atrium/             # Atrium content editor
│   └── assistant-ui/       # Assistant UI integration
├── lib/                    # Core libraries
│   ├── ai/                 # AI provider factory
│   ├── auth/               # Authentication utilities
│   ├── content/            # Atrium content services
│   ├── db/                 # Drizzle ORM, schema, queries
│   ├── nexus/              # Nexus chat logic
│   ├── safety/             # Content safety, PII tokenization
│   ├── streaming/          # SSE streaming infrastructure
│   └── tools/              # AI tool definitions
├── infra/                  # AWS CDK infrastructure
│   ├── lib/                # CDK stack definitions
│   ├── database/           # Migrations, schema
│   └── agent-image/        # Agent platform Docker
├── tests/                  # Test suites
│   ├── unit/               # Unit tests
│   ├── e2e/                # Playwright E2E tests
│   └── smoke/              # Smoke tests
└── docs/                   # Comprehensive documentation
    ├── ARCHITECTURE.md     # Full architecture reference
    ├── DEPLOYMENT.md       # Deployment guide
    └── features/           # Feature-specific docs
```

## Key Source References

| Domain | Key Files |
|--------|-----------|
| App Entry | `/app/layout.tsx`, `/server.ts` |
| Auth | `/auth.ts`, `/lib/auth/server-session.ts` |
| Database | `/lib/db/drizzle-client.ts`, `/lib/db/schema/` |
| AI Streaming | `/lib/streaming/unified-streaming-service.ts` |
| Content API | `/lib/content/content-service.ts` |
| Nexus Chat | `/lib/nexus/history-adapter.ts` |
| MCP Tools | `/lib/mcp/content-tools.ts` |
| Infrastructure | `/infra/lib/aistudio-stack.ts` |

## Existing Documentation

AI Studio has extensive documentation in `/docs/`:
- [ARCHITECTURE.md](../docs/ARCHITECTURE.md) - Complete system architecture
- [DEPLOYMENT.md](../docs/DEPLOYMENT.md) - AWS deployment guide
- [API_REFERENCE.md](../docs/API_REFERENCE.md) - API documentation
- [guides/](../docs/guides/) - Development guides (logging, testing, TypeScript)
- [features/](../docs/features/) - Feature-specific documentation

This OpenWiki provides an opinionated map and synthesis layer over those docs for quick navigation and agent-friendly summaries.
