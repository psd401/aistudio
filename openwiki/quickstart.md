---
type: Quickstart
title: AI Studio Codebase Overview
description: Open-source K-12 AI platform providing multi-model chat, custom assistants, agent-native content workspace, and Google Workspace integration at 90% lower cost than individual licenses.
tags: [quickstart, overview, navigation]
---

# AI Studio

**Bring frontier AI to K-12 education—securely, affordably, and responsibly.**

AI Studio is an open-source platform that provides K-12 educators and students with access to cutting-edge generative AI models. Built with privacy-first architecture and deployed within district infrastructure, it offers multi-model access (GPT-5, Claude Opus, Gemini) at a fraction of individual subscription costs.

## What This Codebase Does

| Domain | Description |
|--------|-------------|
| **Nexus Chat** | Conversational AI with automatic model routing, conversation history, MCP tool integration, and real-time streaming |
| **Assistant Architect** | No-code custom AI assistant builder with visual prompt chain designer, variable substitution, and scheduled execution |
| **Atrium** | Agent-native content workspace supporting documents and interactive artifacts with version control and permission-aware publishing |
| **Agent Platform** | Extensible skill system for AI agents with Google Workspace integration, Cedar-based governance, and MCP tool exposure |
| **Knowledge Repositories** | Document upload, OCR processing, vector embeddings, and semantic search for context-aware AI responses |
| **API Platform** | REST API v1 for external integrations, OAuth2/OIDC provider, and API key management |

## Quick Navigation

### Architecture & Infrastructure
- **[architecture/overview.md](architecture/overview.md)** — Technology stack, design patterns, layered architecture, and key concepts
- **[infrastructure/overview.md](infrastructure/overview.md)** — AWS CDK infrastructure, ECS deployment, Aurora database, Lambda functions
- **[data-models/overview.md](data-models/overview.md)** — Drizzle ORM schema, key database tables, migrations

### Application Features
- **[app-features/overview.md](app-features/overview.md)** — Nexus Chat, Assistant Architect, Atrium, Knowledge Repositories, Model Compare

### Agent Platform
- **[agent-platform/overview.md](agent-platform/overview.md)** — Agent skills system, Google Workspace integration, MCP server

### Integration & APIs
- **[api-integration/overview.md](api-integration/overview.md)** — REST API v1, OAuth2/OIDC provider, MCP tools

## Technology Stack

**Frontend**: Next.js 16 App Router • React 19 • Shadcn UI • Tailwind CSS

**Backend**: ECS Fargate (SSR) • Aurora Serverless v2 (PostgreSQL) • Drizzle ORM

**AI**: Vercel AI SDK v6 • OpenAI • Google Gemini • Amazon Bedrock • Azure OpenAI

**Auth**: AWS Cognito + Google OAuth • NextAuth v5 • RBAC • API Keys

**Infrastructure**: AWS CDK • S3 • CloudWatch • Lambda

## Critical Development Rules

1. **Type Safety**: No `any` types. Run `bun run lint` and `bun run typecheck` before commits
2. **Database Migrations**: Files 001-005 are immutable. Add migrations 010+ and update `/infra/database/migrations.json`
3. **Logging**: Never use `console.log/error`. Use `@/lib/logger` (exception: standalone CJS scripts)
4. **Git Flow**: PRs target `dev` branch, never `main`
5. **Nexus Conversations**: Read `/docs/features/nexus-conversation-architecture.md` before modifying conversation code
6. **API Changes**: Update both `docs/API/v1/openapi.yaml` and `docs/API/v1/context-graph.md` for API v1 modifications

## Development Quick Start

```bash
# Local development with Docker PostgreSQL
bun run db:up              # Start local PostgreSQL
bun run db:seed            # Create test users (admin/staff/student)
bun run dev:local          # Run Next.js with local database

# Development without Docker
bun run dev                # Start dev server (port 3000)
bun run build              # Build for production
bun run lint               # MUST pass before commit
bun run typecheck          # MUST pass before commit

# Infrastructure deployment
cd infra && bunx cdk deploy --all
```

## Key Source Locations

| Area | Path |
|------|------|
| Pages & API Routes | `/app` |
| Server Actions | `/actions/*.actions.ts` |
| UI Components | `/components` |
| Core Utilities | `/lib` |
| AWS CDK Infrastructure | `/infra` |
| Agent Skills | `/infra/agent-image/skills/` |
| Database Schema | `/lib/db/schema/` |
| E2E Tests | `/tests/e2e/` |
| Feature Documentation | `/docs/features/` |

## Backlog

The following areas have substantial existing documentation and are deferred from this wiki:

- **API Reference**: See `/docs/API_REFERENCE.md`
- **Deployment Guide**: See `/docs/DEPLOYMENT.md`
- **Testing Guide**: See `/docs/guides/TESTING.md`
- **K-12 Content Safety**: See `/docs/features/k12-content-safety.md`
- **Individual Skill Docs**: See `/infra/agent-image/skills/*/SKILL.md`
- **Database Migrations**: See `/docs/database/drizzle-migration-guide.md`
