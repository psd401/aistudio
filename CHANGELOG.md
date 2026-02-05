# Changelog

All notable changes to AI Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-02-05

### Added

- **API v1 Platform** — REST API with OpenAPI spec for external integrations. Endpoints for assistants, context graph, conversations, and jobs. Authenticated via API key, OAuth JWT, or session.
- **OAuth2/OIDC Provider** — Authorization Code Flow with PKCE. Admin UI for client registration. KMS-signed JWTs in production. Access tokens (15min), refresh tokens (24hr), ID tokens.
- **MCP Server** — Model Context Protocol server exposing 5 tools (search_decisions, capture_decision, list_assistants, execute_assistant, get_decision_graph) over streamable HTTP transport.
- **Decision Framework** — Structured decision capture with context, alternatives, evidence, and outcomes. Graph-based relationships between decisions. Full-text and semantic search.
- **K-12 Bedrock Guardrails** — Amazon Bedrock content filtering and PII protection. DynamoDB-backed configuration. SNS real-time alerts. Detect-only mode by default.
- **API Key Management** — User-managed API keys with `sk-` prefix. Argon2id hashing. Per-key scopes, rate limiting (60 req/min), usage analytics. Max 10 keys per user.
- **User Settings Page** — Consolidated settings UI with API keys tab, preferences, and profile management.
- **Assistant Architect Improvements** — Conversation continuity across executions. Provider-based model filtering. Enhanced SSE event streaming.
- **Dashboard Redesign** — Updated layout with usage statistics and quick actions.
- **Tutorials Library** — In-app tutorial content for onboarding educators and students.
- **Chart Visualization** — Recharts-based data visualization in conversations.
- **Local Docker Development** — `npm run db:up`, `npm run dev:local`, `npm run db:seed` for fully local development without AWS dependencies.
- **Integration Guides** — New docs for MCP, OAuth, and API v1 quickstart.

### Changed

- **Database ORM** — Complete migration from RDS Data API to Drizzle ORM with postgres.js driver. Type-safe queries via `executeQuery`/`executeTransaction`. Connection pooling (max 20 per container).
- **Next.js 16** — Upgraded from Next.js 15 to 16.1.6.
- **AI SDK v6** — Upgraded from Vercel AI SDK v5 to v6.0 with updated provider packages.
- **React 19** — Updated to React 19.2.4.
- **Lambda Power-Tuning** — 66% memory reduction (3GB to 1GB default) via AWS Lambda Power Tuning.

### Fixed

- SSE connection error log noise (#747)
- Model-not-found errors (#746)
- Timestamp conversion issues (#745)
- Presigned URL refresh for expired S3 URLs (#737)
- Guardrails false positives (#727, #742) — Disabled PROMPT_ATTACK filter, set topics to detect-only
- Message count reconciliation (#719)
- React Compiler violations (#461)

### Infrastructure

- **GuardrailsStack** — New CDK stack: Bedrock Guardrails + DynamoDB config table + SNS alert topic
- **Aurora Auto-Pause** — Dev environments scale to 0 ACU when idle (~$44/month savings)
- **ECS Spot Instances** — 70% cost savings on non-critical workloads
- **VPC Consolidation** — Reduced from 2 VPCs to 1 shared VPC across all stacks

### Breaking Changes

- `documents.conversation_id` column type changed to UUID
- `chatEnabled` column removed from relevant tables
- OAuth token response includes new fields (`id_token`, updated `scope` format)
- API key format standardized to `sk-` prefix

### Dependencies

| Package | Version |
|---------|---------|
| next | 16.1.6 |
| ai | ~6.0.0 |
| drizzle-orm | ^0.45.1 |
| react | ^19.2.4 |
| @ai-sdk/react | ^3.0.71 |
| @ai-sdk/openai | ^3.0.7 |
| @ai-sdk/google | ^3.0.20 |
| @ai-sdk/amazon-bedrock | ^4.0.48 |
| @ai-sdk/azure | ^3.0.26 |

## [1.0.0] - 2025-01-19

### Added - First Public Release

#### Core Features
- **Nexus Chat**: Multi-model conversational AI with GPT-5, Claude Opus, and Google Gemini
  - Real-time streaming responses via Server-Sent Events (SSE)
  - Conversation history and organization with folders
  - Model switching mid-conversation
  - Response caching for cost optimization
- **Assistant Architect**: No-code AI assistant builder
  - Visual prompt chain designer with variable substitution
  - Knowledge repository integration for context-aware responses
  - Tool integration and function calling
  - Scheduled execution support
- **Knowledge Repositories**: Document upload and semantic search
  - Multi-format support (PDF, DOCX, TXT) with OCR via AWS Textract
  - Vector embeddings using pgvector extension
  - Chunk-based search with relevance ranking
  - URL import and processing
- **Model Compare**: Side-by-side AI model evaluation
  - Parallel execution across multiple models
  - Token usage and cost analysis
  - Performance metrics (latency, throughput)
  - Export comparison results

#### Infrastructure
- **AWS ECS Fargate** deployment with Application Load Balancer
  - Auto-scaling based on CPU/memory metrics
  - HTTP/2 support for efficient streaming
  - Graviton2 (ARM64) optimization for 20% cost savings
  - Fargate Spot for 70% savings on non-critical workloads
- **Aurora Serverless v2** PostgreSQL database
  - Auto-pause in development (scales to 0 ACU when idle)
  - pgvector extension for similarity search
  - RDS Data API for connection-less queries
  - Automated backups with 7-30 day retention
- **Multi-AZ VPC** with comprehensive network topology
  - Public, private-application, private-data, and isolated subnets
  - 14+ VPC endpoints for cost optimization
  - Network ACLs and security groups for defense in depth
  - VPC Flow Logs for security monitoring
- **AWS CDK Infrastructure as Code**
  - Reusable constructs for consistent patterns
  - Tag-based IAM least privilege policies
  - Environment-specific configurations (dev, prod)
  - Automated CloudFormation stack deployment

#### Authentication & Security
- **AWS Cognito** with Google OAuth 2.0 integration
- **NextAuth v5** for session management (JWT-based)
- **Role-Based Access Control (RBAC)** with tool-level permissions
  - Admin, Teacher, Student roles
  - Granular access to AI models and features
  - Audit logging for sensitive operations
- **Tag-based IAM policies** preventing cross-environment access
- **Secrets Manager** integration for secure credential storage
- **Parameterized SQL queries** preventing injection attacks

#### Monitoring & Observability
- **Consolidated CloudWatch Dashboard** with 115+ widgets
  - Lambda performance metrics
  - ECS health and auto-scaling
  - RDS query performance
  - API latency percentiles
- **AWS Distro for OpenTelemetry (ADOT)** for distributed tracing
- **Structured logging** with Winston logger
  - Request ID tracking across services
  - PII sanitization via `sanitizeForLogging()`
  - Configurable log levels per environment
- **Circuit breaker pattern** for AI provider reliability
- **Adaptive timeouts** based on model capabilities

#### Documentation
- **10,000+ lines of architectural diagrams** (Mermaid.js)
  - CDK stack dependencies and deployment order
  - VPC network topology with security groups
  - Complete AWS service architecture
  - Database ERD (54 tables across 11 domains)
  - Authentication flow (OAuth 2.0 + Cognito + NextAuth)
  - Request flow diagrams for all major features
  - Assistant Architect execution pipeline
  - Document processing pipeline
  - Streaming architecture (SSE implementation)
- **Comprehensive guides**
  - Complete deployment guide with safety checks
  - API reference for all endpoints
  - Error reference with debugging patterns
  - Troubleshooting guide for common issues
  - Security best practices
  - Performance optimization strategies

#### Cost Optimizations
- **90% cost reduction** vs. individual AI licenses
  - Traditional: $24,000/year (100 users × $20/month ChatGPT Plus)
  - AI Studio: $7,800/year with GPT-5
  - With mixed models (Gemini + GPT-4 mini): ~$2,400/year
- **Lambda PowerTuning**: 66% memory reduction for all functions
- **Aurora auto-pause**: ~$44/month savings in development
- **S3 Intelligent-Tiering**: Automatic cost optimization for documents
- **VPC endpoints**: Eliminate NAT gateway data transfer costs

### Technical Details

#### Tech Stack
- **Frontend**: Next.js 15 with App Router, React 19, Shadcn UI, Tailwind CSS
- **Backend**: ECS Fargate, Aurora Serverless v2 PostgreSQL, AWS Lambda
- **AI Integration**: Vercel AI SDK v5 with OpenAI, Anthropic, Google, Bedrock providers
- **Storage**: S3 for documents, pgvector for embeddings
- **Authentication**: Cognito + NextAuth v5
- **Infrastructure**: AWS CDK (TypeScript)
- **Monitoring**: CloudWatch + ADOT + OpenTelemetry

#### Database Schema
- **54 tables** across 11 functional domains
  - Core: users, roles, user_roles, tools, tool_access
  - Nexus Chat: conversations, messages, folders, caching, metrics
  - Assistant Architect: chain_prompts, executions, scheduling, tool_integrations
  - Knowledge: repositories, items, chunks, embeddings (pgvector)
  - MCP Integration: servers, capabilities, audit_logs
  - System: settings, migrations, error_logs

#### Performance
- **Streaming latency**: < 500ms Time to First Token (TTFT)
- **Database queries**: < 100ms p95 for most operations
- **API response**: < 200ms p95 for non-streaming endpoints
- **Concurrent streams**: Supports 100+ simultaneous SSE connections
- **Document processing**: Async pipeline with SQS for scalability

### Security Features
- All data processed within district infrastructure (no third-party SaaS)
- FERPA and COPPA compliance ready
- Tag-based IAM preventing cross-environment access (dev cannot access prod)
- Client and server-side input validation
- Rate limiting and quotas (future enhancement)
- Security scanning via CodeQL and Dependabot
- Infrastructure validation via CDK Nag

### Migration Notes
This is the first public release. Previously, AI Studio was internal-only to Peninsula School District (PSD401).

**Breaking Changes from pre-1.0**:
- Migrated from AWS Amplify to ECS Fargate (different deployment process)
- Removed legacy Drizzle ORM in favor of RDS Data API
- Consolidated from 2 VPCs to 1 shared VPC
- Updated to NextAuth v5 (breaking changes from v4)
- Upgraded to Next.js 15 (App Router required)

[1.1.0]: https://github.com/psd401/aistudio/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/psd401/aistudio/releases/tag/v1.0.0
