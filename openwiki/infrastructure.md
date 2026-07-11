# Infrastructure

AI Studio is deployed on AWS using CDK (Cloud Development Kit) for infrastructure-as-code. The architecture leverages ECS Fargate for containerized Next.js, Aurora Serverless v2 for PostgreSQL, and integrates with Cognito for authentication.

## CDK Stack Structure

### Main Stacks

| Stack | Purpose |
|-------|---------|
| `AIStudio-AuthStack` | Cognito User Pool, App Client, Identity Pool |
| `AIStudio-DatabaseStack` | Aurora Serverless v2, SSM parameters for DB connection |
| `AIStudio-FrontendStack` | ECS Fargate, ALB, S3, CloudWatch |
| `AIStudio-AgentPlatformStack` | ECR, AgentCore, DynamoDB tables for agent state |
| `AIStudio-SchedulerStack` | EventBridge Scheduler for scheduled executions |

### Stack Dependencies

```
AuthStack (no dependencies)
     │
     ▼
DatabaseStack (depends on AuthStack for SSM params)
     │
     ▼
FrontendStack (depends on DatabaseStack, AuthStack)
     │
     ▼
AgentPlatformStack (depends on FrontendStack)
```

**Source**: `/infra/lib/aistudio-stack.ts`

## Container Architecture

### Main Application (Next.js)

- **Base Image**: Node.js 20 LTS
- **Runtime**: Next.js 16 with standalone output
- **Hosting**: ECS Fargate with Application Load Balancer
- **Auto-scaling**: Based on CPU/memory utilization

**Dockerfile**: `/Dockerfile`

### Agent Platform (OpenClaw)

- **Base Image**: ARM64 Graviton-optimized
- **Runtime**: AgentCore Runtime + Python harness
- **Tools**: Native Bedrock provider, MCP tools
- **Security**: Supply-chain security gates

**Source**: `/infra/agent-image/Dockerfile`

## Database Infrastructure

### Aurora Serverless v2

- **Engine**: PostgreSQL 15+
- **Extensions**: pgvector for vector similarity
- **Credentials**: Stored in AWS Secrets Manager
- **Connection**: Via RDS Data API or direct connection

### Migrations

- **Format**: SQL files in `/infra/database/`
- **Manifest**: `migrations.json` tracks migration order
- **Execution**: Lambda-based via RDS Data API
- **Constraint**: Files 001-005 are IMMUTABLE

**Migration Workflow**:
1. Create SQL file (e.g., `010-add-table.sql`)
2. Add filename to `migrationFiles` array in `migrations.json`
3. Deploy: `cd infra && bunx cdk deploy AIStudio-DatabaseStack`

**Source**: `/infra/database/migrations.json`

### Database Schema

80+ tables across domains:

| Domain | Key Tables |
|--------|------------|
| Auth | `users`, `roles`, `user_roles`, `capabilities` |
| Content | `content_objects`, `content_versions`, `content_publications` |
| Nexus | `nexus_conversations`, `nexus_messages`, `nexus_mcp_connections` |
| Knowledge | `knowledge_repositories`, `repository_items`, `repository_item_chunks` |
| Agent | `agent_sessions`, `agent_messages` (+ iteration telemetry), `agent_tool_invocations` |

**Schema Source**: `/lib/db/schema/tables/`

## Agent Platform

### Components

- **ECR Repository**: Docker image storage for agent container
- **AgentCore Runtime**: AWS managed agent execution
- **S3 Workspace Buckets**: Agent file storage
- **DynamoDB Tables**: 7 tables for agent state management (including triage)
- **Router Lambda**: Google Chat integration
- **Job Runner**: Async Fargate tasks for long-running turns (bypasses Lambda 15-min limit)

### Build-time Eval Gates

Before pushing an agent image, `build-and-push.sh` runs automated gates that would have caught previous production failures (dead-boot r10, missing provider r11, SOUL.md truncation #1138):

| Gate | Check | Source |
|------|-------|--------|
| Instruction-budget | Bootstrap files fit within `openclaw.json` `bootstrapMaxChars` / `bootstrapTotalMaxChars` limits | `/infra/agent-image/check_bootstrap_budget.py` |
| Config consistency | `contextWindow` values are positive ints; `apiKey` env-vars are hydrated in wrapper | `/infra/agent-image/check_config_consistency.py` |
| Boot probe | Container emits `BOOT_OK` marker within timeout | Runtime check in `build-and-push.sh` |
| Canary turn | Agent responds to a test prompt | Runtime check in `build-and-push.sh` |

Two separate bypass flags for emergencies:
- `SKIP_STATIC_GATE=1` — Skip instruction-budget + config-consistency (rarely needed)
- `SKIP_PROBE_GATE=1` — Skip boot probe + canary turn (if probe itself is broken)

### Iteration Telemetry (Issue #1161)

Agent turns are measured via `agent_messages` columns added in migration 100:

| Column | Purpose |
|--------|---------|
| `model_call_count` | Upstream model round-trips per turn |
| `duration_ms` | Wall-clock time from invocation to final yield |
| `nudged` | Whether empty-turn nudge fired |

Dashboard aggregates (via `/actions/admin/agent-telemetry.actions.ts`):
- `avgModelCallsPerTurn` / `p95ModelCallsPerTurn` — surface expensive turns
- `emptyTurnRate` — fraction of turns ending empty (unrecovered)
- `nudgeFireRate` — fraction where nudge fired (recovered + unrecovered)

Trace export for session analysis:
```bash
bunx tsx scripts/agent-trace-export.ts <session-id>
bunx tsx scripts/agent-trace-export.ts <session-id> --json  # machine-readable
```

### Job Runner (Issue #1138)

Long-running agent turns hit Lambda's 15-minute deadline. The router promotes these to async Fargate tasks:

1. Router detects turn approaching deadline (promoteToJob in `index.ts`)
2. Launches ECS Fargate task with `JOB_PAYLOAD` env var
3. Job runner (`job-main.ts`) invokes AgentCore with up to 2-hour limit
4. SSE heartbeats keep stream alive; session lock renewed every 10 minutes
5. Final answer posted to originating Google Chat space

**Source**: `/infra/lambdas/agent-router/job-main.ts`

### DynamoDB Tables

| Table | Purpose |
|-------|---------|
| `AgentSessions` | Active agent sessions |
| `AgentMessages` | Message history |
| `AgentToolInvocations` | Tool call records |
| `AgentFailures` | Failure tracking |
| `AgentHealthSnapshots` | Health monitoring |
| `AgentSkills` | Skill registry |
| `psd-agent-triage-<env>` | Per-user email triage state (#1172) |

**Source**: `/infra/lib/agent-platform-stack.ts`

### Agent Skills

The agent container bundles 25+ skills under `/infra/agent-image/skills/`. Each skill has a `SKILL.md` frontmatter contract that specifies:

- `name`: kebab-case identifier
- `summary`: one-line catalog entry (for `psd-skills-meta`)
- `description`: what it does + when to use (model-facing, ~30–50 tokens)
- `allowed-tools`: tool scope (e.g. `Bash(node:*)`)

Skills use progressive disclosure: only `name` + `description` load into the system prompt (always-on), while the full `SKILL.md` body loads on-demand when triggered.

**Skill Authoring Guide**: `/docs/guides/agent-skill-authoring.md`

Key skills:

| Skill | Purpose | Source |
|-------|---------|--------|
| `psd-canva` | Per-user Canva OAuth, design creation, PDF/PNG export via Connect REST API (#1176) | `/infra/agent-image/skills/psd-canva/` |
| `psd-last30days` | Keyless social/community research (HN, Reddit, arXiv, GitHub, Google News) with cited briefs (#1180) | `/infra/agent-image/skills/psd-last30days/` |
| `psd-aistudio` | Live capability catalog from AI Studio's registries via `describe_capabilities` MCP meta-tool (#1173) | `/infra/agent-image/skills/psd-aistudio/` |
| `psd-email-triage` | Configure smart email triage from chat (rules, escalation, digest) | `/infra/agent-image/skills/psd-email-triage/` |

### MCP describe_capabilities Meta-Tool (#1100)

The `describe_capabilities` MCP tool provides a live projection of AI Studio's invocable actions and web-app features:

- **Actions**: MCP-exposed tools with `agentInvocable: true` flag
- **Features**: Role-gated UI features to steer users toward
- **Scopes**: API-scope reference for explaining access requirements

The catalog is rebuilt on every call from source-of-truth registries (`TOOL_MANIFEST`, `CAPABILITY_MANIFEST`, `API_SCOPES`), ensuring it never falls behind deployed code.

**Sources**: `/lib/capabilities/capability-catalog.ts`, `/lib/mcp/tool-handlers.ts`

### Email Triage Architecture (Phase 2)

Email triage uses a **dispatcher → SQS FIFO → worker** fanout architecture (#1172):

```
EventBridge (5-min)  ──►  Dispatcher  ──►  SQS FIFO queue  ──►  Worker
             │                          │                      │
             │    one message per user  │                      │
             │    + sweep kicks         │                      │
             └──────────────────────────┘                      ▼
                                                Gmail history → rules → LLM → labels
```

The dispatcher enqueues one message per enabled user; the worker does per-user Gmail/Bedrock work. This prevents one slow user from blocking others.

**Sweep**: Initial inbox backfill (last 30 days, ≤1000 messages) runs through the same pipeline with escalation suppressed. State persisted in DDB `sweep` map for resumption.

**Sources**: `/infra/lambdas/agent-triage-poll/dispatcher.ts`, `/infra/lambdas/agent-triage-poll/sweep.ts`, `/docs/operations/email-triage.md`

### Canva Integration (psd-canva)

Per-user Canva access for AI Studio agents via the Canva Connect REST API (#1176). Mirrors the Google Workspace integration model: a confidential OAuth client owned by the deploying district, per-user refresh tokens in Secrets Manager, and a self-serve consent flow.

**Deployment prerequisites** (one-time per district/environment):
1. Create an integration in Canva Developer Portal with redirect URL `https://<your-app-domain>/agent-connect-canva/callback`
2. Enable scopes: `design:content:read design:meta:read design:content:write asset:read asset:write folder:read profile:read`
3. Populate Secrets Manager: `aws secretsmanager put-secret-value --secret-id psd-agent/<env>/canva-oauth-client --secret-string '{"client_id":"...","client_secret":"..."}'`
4. Deploy AgentPlatformStack + FrontendStack, then rebuild/push the agent image

**User flow**: User asks agent something Canva-related → skill emits `needs-auth` (exit 10) with consent link → user clicks and completes OAuth → refresh token stored in per-user secret. Subsequent requests work automatically.

**Known limits** (by design): No autofill/brand templates (Enterprise-gated), no in-design content editing (Connect REST API limitation).

**Source**: `/docs/features/agent-canva-integration.md`

### Harness Adapter

Python abstraction for provider integration:

```python
# infra/agent-image/harness_adapter.py
class HarnessAdapter:
    def create_provider(self, provider_name: str): ...
    def stream_response(self, messages, tools): ...
```

## Deployment Workflow

### Commands

```bash
# From /infra directory
bunx cdk deploy --all                          # Deploy all stacks
bunx cdk deploy AIStudio-FrontendStack-Dev     # Deploy single stack
bunx cdk diff                                  # Preview changes
bunx cdk destroy AIStudio-FrontendStack-Dev    # Tear down
```

### Environment Promotion

1. **Dev**: `AIStudio-*-Dev` stacks
2. **Prod**: `AIStudio-*-Prod` stacks (after validation)

### Deployment Safety

- Explicit stack dependencies
- SSM parameter sharing between stacks
- Snapshot restore support for database

**Source**: `/infra/DEPLOYMENT_SAFETY_CHECKLIST.md`

## CI/CD Pipeline

### GitHub Actions Workflows

| Workflow | Trigger | Actions |
|----------|---------|---------|
| CI | Push to any branch | lint, typecheck, test |
| CDK Synth | PR to dev | Validate CDK templates |
| Deploy Dev | Push to dev | Deploy dev stacks |
| OpenWiki Update | Push to dev | Update OpenWiki docs |

**Source**: `/.github/workflows/`

## Monitoring & Observability

### CloudWatch Integration

- **Structured Logging**: JSON logs via `/lib/logger.ts`
- **Metrics**: Custom metrics for AI operations
- **Dashboards**: Pre-built dashboards for monitoring
- **Alarms**: SNS notifications for thresholds

### OpenTelemetry

- ADOT (AWS Distro for OpenTelemetry)
- Distributed tracing across services
- Request correlation via request IDs

**Source**: `/instrumentation.ts`

## Network Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         VPC                                   │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                    Public Subnets                       │  │
│  │     ┌─────────────────┐    ┌─────────────────┐        │  │
│  │     │    NAT Gateway  │    │   ALB           │        │  │
│  │     └─────────────────┘    └────────┬────────┘        │  │
│  └─────────────────────────────────────┼──────────────────┘  │
│                                        │                      │
│  ┌─────────────────────────────────────▼──────────────────┐  │
│  │                   Private Subnets                        │  │
│  │     ┌─────────────────┐    ┌─────────────────┐        │  │
│  │     │  ECS Fargate    │    │  Aurora         │        │  │
│  │     │  (Next.js)      │    │  Serverless v2  │        │  │
│  │     └─────────────────┘    └─────────────────┘        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                   Isolated Subnets                       │  │
│  │     ┌─────────────────┐                                 │  │
│  │     │  VPC Endpoints   │                                 │  │
│  │     └─────────────────┘                                 │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**Source**: `/docs/diagrams/02-vpc-network-topology.md`

## Storage

### S3 Buckets

| Bucket | Purpose | Lifecycle |
|--------|---------|-----------|
| Documents | Uploaded documents | 90-day transition to IA |
| Content Snapshots | S3 document snapshots | Indefinite |
| Agent Workspace | Agent file storage | Per-session cleanup |

**Source**: `/docs/features/s3-storage-optimization.md`

## Source References

| Component | Primary Files |
|-----------|---------------|
| Main Stack | `/infra/lib/aistudio-stack.ts` |
| Auth Stack | `/infra/lib/auth-stack.ts` |
| Database Stack | `/infra/lib/database-stack.ts` |
| Frontend Stack | `/infra/lib/frontend-stack.ts` |
| Agent Platform | `/infra/lib/agent-platform-stack.ts` |
| Migrations | `/infra/database/migrations.json` |
| Agent Docker | `/infra/agent-image/Dockerfile` |
| Harness Adapter | `/infra/agent-image/harness_adapter.py` |
| Agent Wrapper | `/infra/agent-image/agentcore_wrapper.py` |
| Bootstrap Budget Gate | `/infra/agent-image/check_bootstrap_budget.py` |
| Config Consistency Gate | `/infra/agent-image/check_config_consistency.py` |
| Trace Export | `/scripts/agent-trace-export.ts` |
| Job Runner | `/infra/lambdas/agent-router/job-main.ts` |
| Agent Skills | `/infra/agent-image/skills/` |
| Capability Catalog | `/lib/capabilities/capability-catalog.ts` |
| Email Triage Dispatcher | `/infra/lambdas/agent-triage-poll/dispatcher.ts` |
| Email Triage Worker | `/infra/lambdas/agent-triage-poll/worker.ts` |
| Skill Authoring Guide | `/docs/guides/agent-skill-authoring.md` |
| Deploy Commands | `/infra/DEPLOYMENT_COMMANDS.md` |
| Safety Checklist | `/infra/DEPLOYMENT_SAFETY_CHECKLIST.md` |
