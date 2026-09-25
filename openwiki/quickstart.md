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
| **Nexus Chat** | Conversational AI with automatic model routing (including PSD-data queries), conversation history, MCP tool integration, and real-time streaming |
| **Assistant Architect** | No-code custom AI assistant builder with visual prompt chain designer, variable substitution, and scheduled execution |
| **Atrium** | Agent-native content workspace supporting documents and interactive artifacts with viewer-scoped data bridge, drag-and-drop organization, and permission-aware publishing |
| **Agent Platform** | Extensible skill system for AI agents with Google Workspace integration, Cedar-based governance, and MCP tool exposure |
| **Knowledge Repositories** | Document upload, OCR processing, vector embeddings, and semantic search for context-aware AI responses |
| **API Platform** | REST API v1 for external integrations, OAuth2/OIDC provider, and API key management |

## Quick Navigation

### Architecture & Infrastructure
- **[architecture/overview.md](architecture/overview.md)** — Technology stack, design patterns, layered architecture, and key concepts
- **[architecture/streaming.md](architecture/streaming.md)** — SSE streaming architecture, keep-alive implementation, provider adapters (#1698)
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
5. **SSE Keep-Alive**: Long-running AI turns require SSE comment frames (`: keep-alive\n\n`) every 15s to prevent ALB idle timeout. Use `withSseKeepAlive` for existing streams or `deferUIMessageStreamResponse` for deferred responses. SEE **[architecture/streaming.md](architecture/streaming.md)** for complete contract (#1698).
6. **Nexus Conversations**: Read `/docs/features/nexus-conversation-architecture.md` before modifying conversation code — repository bindings, readiness gates, and tool scoping have subtle invariants
7. **Attachment Adapters**: When modifying attachment code, the conversation ID accessor must be closure-backed, never a memo dependency of the adapter — see **[app-features/overview.md](app-features/overview.md#attachments-1735)** for shared hook pattern (#1735)
8. **Workspace Artifact Routing**: An editable artifact open beside chat gets PSD Data connector attached regardless of message classification — "add a dropdown" on a live dashboard is a schema question. See **[app-features/overview.md](app-features/overview.md#workspace-artifact-psd-data-routing-1786)** for routing predicates and do-not-guess guidance (#1786)
9. **Repository Readiness**: Empty repositories bind but don\'t block chat turns; `searchableRepositoryIds` excludes them from tool scope — see **[app-features/overview.md](app-features/overview.md#repository-readiness-gate)** for the gate contract (#1733)
10. **API Changes**: Update both `docs/API/v1/openapi.yaml` and `docs/API/v1/context-graph.md` for API v1 modifications
11. **Visibility Changes**: Read grants before modifying — `PATCH /content/:id/visibility` replaces the grant list, use `--add-grants`/`--remove-grants` for merge operations (#1763)
12. **Grant Targets**: `user` and `group` grants validate target existence before storing; see **[app-features/overview.md](app-features/overview.md#grant-target-existence-validation-1777)** for contract (#1777)
13. **Typed Bridge Errors**: AtriumData bridge failures carry typed `err.code` (unauthenticated, forbidden, not_query_mode, rate_limited, timeout, query_error, too_many_requests, unavailable). Wrap every bridge call in try/catch — see **[app-features/overview.md](app-features/overview.md#typed-bridge-errors-1787)** for contract and handling pattern (#1787)
14. **Artifact Data Concurrency** (#1788): Queries now run in parallel (up to 6 at once) via fetch Route Handler, not serialized Server Actions. Excess requests queue rather than reject. The server's 30s budget spans preflight + MCP handshake + execution — see **[app-features/overview.md](app-features/overview.md#query-concurrency-and-transport-1788)** for concurrency, timeout, and queue contracts.
15. **MCP Tool Versioning**: Tool schemas are immutable at a given version — changing a schema requires bumping the version. Old versions must be preserved as frozen legacy entries in `LEGACY_MCP_MANIFEST_ENTRIES`. See **[api-integration/overview.md](api-integration/overview.md#mcp-tool-versioning-contract)** for versioning contract (#1710, #1817)
16. **Toast & Form Validation**: The app uses sonner for toasts; `useToast()` is an adapter — never mount a second toast root. For blocked form submits, use `handleSubmit` callbacks (not `trigger()` + `formState.errors`) and ensure fields forward refs for `setFocus`. `useFormField` must use `useFormState({ name })` to subscribe. See `/docs/guides/silent-failure-patterns.md` and **[app-features/overview.md](app-features/overview.md#create-form-validation-1697)** for patterns (#1697)
17. **Drive Query Parameters (#1801)**: `--params` MUST be a parseable JSON object. Single-quoted values (Drive `q` parameter) cannot survive tokenizer — use `--params-file` instead. The broker rejects unparseable `--params` with reason `params_not_json` before any mutation gates run. See **[agent-platform/overview.md](agent-platform/overview.md#query-parameter-validation-security-1801)** for order invariant and payload-file flow changes.
18. **Web Fetch Tool (#1696)**: Nexus chat attaches `web_fetch` on every turn (NOT single-step surfaces like model compare). Page text is fenced as `<untrusted_web_content>` — the model must never follow directions inside the fence. Skill `allowed-tools` pins can exclude it. A URL message routes as `general`, never as `web-search`, so the turn never fails for lack of a search-capable model. See **[app-features/overview.md](app-features/overview.md#web-fetch-tool-1696)** for SSRF guards, content fencing, routing implications, and step budget.
19. **Artifact Preview Frame** (#1788): The canvas keeps the preview iframe mounted on tab toggle to avoid re-running queries. A frame is kept hidden, never first created hidden — charting libraries would initialize at zero size. See **[app-features/overview.md](app-features/overview.md#query-concurrency-and-transport-1788)** for mount key contract.
20. **Workspace Object Binding** (#1791): Conversations opened beside an Atrium artifact record `workspace_object_id` durably — reopening from sidebar restores the panel; "Ask the agent" continues the bound conversation instead of starting fresh. See **[app-features/overview.md](app-features/overview.md#workspace-object-binding-1791)** for binding operations and restore flow.
21. **Draft Auto-Send Handshake** (#1791): In-app navigation to Nexus can auto-send a prefilled draft via a same-tab sessionStorage handshake (`armDraftAutoSend` + `consumeDraftAutoSend`). Links from outside the app only prefills — cannot trigger auto-send. See **[app-features/overview.md](app-features/overview.md#draft-auto-send-handshake-1791)** for security model.
22. **Rename/Re-slug** (#1791): Workspace chat can rename content via `rename_workspace_content` tool. An unpublished rename allocates a fresh slug; ever-published keeps the original slug. See **[app-features/overview.md](app-features/overview.md#rename-and-re-slug-1791)** for transaction and collision handling.
23. **Mode-Only Artifact Updates** (#1791): `update_workspace_artifact` can change only `dataAccess` without providing `code` — no version is created, no §28.3 screening runs. See **[app-features/overview.md](app-features/overview.md#mode-only-artifact-updates-1791)** for contract.
24. **Version Authorship Labels** (#1791): Versions written by Nexus chat show "via Nexus chat" in the dropdown and About rail. The label is viewer-neutral — never "you". See **[app-features/overview.md](app-features/overview.md#version-authorship-labels-1791)** for labeling rules.
25. **Version-Scoped Data-Access Mode** (#1789): `data_access` lives on `content_versions`, not just `content_objects`. Live pages pin the PUBLISHED version's mode — author draft changes cannot re-capability Live. Use `resolveVersionDataAccess()` for every mode resolution. See **[app-features/overview.md](app-features/overview.md#version-scoped-data-access-mode-1789)** for the complete contract.
26. **Artifact Query Limits** (#1792): Numeric limits are defined in ONE module (`lib/content/artifact-query-limits.ts`) and interpolated into model-facing guidance. Default limit is 200 — an unaggregated query silently returns first 200 rows. When changing limits, update both the constant AND the skill file (`infra/agent-image/skills/psd-atrium/SKILL.md`). See **[app-features/overview.md](app-features/overview.md#shared-data-contract-1749-1792)** for limit table and synchronization requirements.
27. **Workspace Panel Resizing** (#1793): Panel width is user-controlled and persists as fraction in localStorage. Minimum widths (380px panel, 320px chat) are enforced; panel wins on narrow containers. Full-screen viewport always shows back control. See **[app-features/overview.md](app-features/overview.md#workspace-panel-layout-1793)** for persistence, clamping, and keyboard accessibility.
<!-- openwiki: broken internal link [app-features/overview.md#data-access-and-artifact-data-bridge] heading anchor "data-access-and-artifact-data-bridge" does not exist in "app-features/overview.md". Fix the href or restore the target, then delete this comment. -->
28. **Authenticated Embeds Data Bridge** (#1790): `ArtifactEmbedBlock` in authenticated readers (`/c/`, editor NodeView) gets the data bridge for LIVE artifacts — `resolveEmbedForReader` decides by audience, not the reader component. Public reader (`/p/`) always resolves `dataBridge: null`. Unpublished artifact embeds render head with NO bridge. See **[app-features/overview.md](app-features/overview.md#data-access-and-artifact-data-bridge)** for bridge table and fail-closed contract.

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
