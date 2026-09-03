---
type: Infrastructure Overview
title: AWS CDK Infrastructure
description: AWS CDK infrastructure with ECS Fargate, Aurora Serverless v2, Cognito authentication, and modular construct library for K-12 AI platform deployment.
tags: [infrastructure, cdk, aws, deployment, ecs]
---

# Infrastructure

AI Studio is deployed on AWS using CDK (Cloud Development Kit) with TypeScript. The infrastructure prioritizes security, cost optimization, and educational compliance requirements.

## Overview

**IaC Tool**: AWS CDK v2
**Location**: `/infra/`

### Deployment Commands

```bash
cd infra && bunx cdk deploy --all                          # Deploy all stacks
cd infra && bunx cdk deploy AIStudio-FrontendStack-Dev     # Deploy single stack
cd infra && bunx cdk diff                                  # Preview changes
```

---

## Stack Architecture

### Core Stacks

| Stack | Purpose |
|-------|---------|
| `FrontendStack` | Next.js SSR on ECS Fargate |
| `ProcessingStack` | Lambda functions for async work |
| `AgentPlatformStack` | Agent infrastructure (skills, mint Lambda) |
| `DatabaseStack` | Aurora Serverless v2 cluster |

### Stack Dependencies

Defined in `/infra/lib/stacks/`, stacks are deployed in order based on SSM parameter flows:

```
NetworkStack → DatabaseStack → ProcessingStack → FrontendStack
                             ↘ AgentPlatformStack
```

See `/docs/diagrams/01-cdk-stack-dependencies.md` for visual diagram.

---

## Reusable Constructs

**Location**: `/infra/lib/constructs/`

CDK constructs provide consistent, secure patterns:

### Security Constructs
- `/security/` — IAM roles, policies, secrets management
- Cedar policy enforcement via `/infra/policies/cedar/`

### Network Constructs
- `/network/` — VPC, subnets, security groups, VPC endpoints
- Multi-AZ deployment with isolated subnets

### Compute Constructs
- `/compute/` — Lambda, ECS patterns
- Hyperframes render function for video generation

### Monitoring Constructs
- `/monitoring/` — CloudWatch dashboards, alarms, ADOT

### Configuration Constructs
- `/config/` — Environment-specific settings

---

## ECS Fargate (Frontend)

### Configuration

**Next.js 16 SSR** deployed on ECS Fargate with:
- Application Load Balancer
- Auto-scaling based on CPU/memory
- Run tasks for streaming responses

### Container Definition

| File | Purpose |
|------|---------|
| `/Dockerfile` | Production container |
| `/Dockerfile.dev` | Development container |
| `/Dockerfile.graviton` | ARM64 support |
| `/infra/lib/constructs/ecs-service.ts` | Service definition |

### Auto-Pause (Dev)

Dev environments scale to 0 when idle, saving ~$44/month:
- Min capacity: 0 (dev), 2 (prod)
- No cold start for prod
- Configured via Aurora and ECS task scaling

---

## Aurora Serverless v2

### Cluster Configuration

| Environment | Min ACU | Max ACU | Auto-Pause |
|-------------|---------|---------|------------|
| **Dev** | 0 | 4 | Yes |
| **Prod** | 2 | 8 | No |

### Connection Management

- PostgreSQL driver with connection pooling
- Max 20 connections per container
- 20s idle timeout
- Graceful shutdown via `/instrumentation.ts`

### Backups

- Automated daily snapshots
- 7-day retention (dev), 30-day (prod)

### Migrations

Migrations run via Lambda function:
1. Read from `/infra/database/migrations.json`
2. Execute SQL files in order
3. Track in `migration_log` table

**Key Files**:
- `/infra/database/` — Migration files
- `/infra/lambdas/database-migration/` — Runner Lambda

---

## Lambda Functions

### Processing Lambdas

**Location**: `/infra/lambdas/`

| Lambda | Purpose |
|--------|---------|
| `textract/` | OCR document processing |
| `group-sync/` | Google Directory synchronization |
| `atrium-content-key-bootstrap/` | Atrium key provisioning |
| `agent-router/` | Agent request routing with promoted turn recovery |

### Agent Router

The `agent-router` Lambda handles agent request routing with automatic failure telemetry hygiene:

**Promoted Turn Recovery**: When an interactive turn times out (~550s ceiling) or overflows context but is promoted to a job queue, `markPromotedTurnRecovered()` downgrades the failure row from `error` to `warn` with `system:job-promotion` acknowledgment. This preserves latency trending while ensuring the Failures tab shows what actually broke.

**Dead-Letter Telemetry**: When a chat turn exhausts its SQS retries and is about to dead-letter, `recordIfHeadedForDlq()` writes a failure row *before* the redrive happens. The function:

- **Extracts owner attribution**: Parses the record body to capture `userId` (sender email) and `sessionId` (space name), so "who was affected?" is answerable from the failure table without decoding SQS bodies by hand
- **Fails safe on missing attributes**: If `ApproximateReceiveCount` is missing or unparseable, records anyway—the prior default of "skip" meant records with no attributes dead-lettered silently
- **Receives retry limit via env var**: `ROUTER_QUEUE_MAX_RECEIVE_COUNT` is passed from the stack (line 122 of `/infra/lib/agent-platform-stack.ts`) to ensure Lambda and queue redrive policy stay synchronized
- **Decouples retry latency from DB health**: Visibility shortening runs before the telemetry write, so a slow or exhausted DB pool cannot block prompt retry

Without this telemetry, deferred retries could vanish with no `agent_failures` row, no metric, and nothing on the usage dashboard. In production (2026-08-20 to 2026-08-31), 50 real user messages died across 8 people while the failure table recorded only 2 router-sourced rows that week—the DLQ alarm had been publishing to a topic with no subscribers.

For multi-turn agent architecture, see **[agent-platform/overview.md](../agent-platform/overview.md)**.

### Agent Platform Lambdas

| Lambda | Purpose |
|--------|---------|
| `agent-mint/` | DWD token broker (isolated security) |
| `hyperframes-render/` | HTML to video rendering |

### Workspace Contract Validation

**Source**: `/infra/agent-image/workspace_contract.py`

During agent image builds, a cutover guard fingerprints the workspace contract (proof version, checkpoint manifest, journal shapes) and compares it against the deployed image. This prevents false-positive cutover triggers from comment or validation-logic changes.

For details, see **[agent-platform/overview.md → Workspace Checkpoint Recovery → Cutover Guard](../agent-platform/overview.md#cutover-guard-build-time-contract-validation)**.

### Lambda Optimization

PowerTuning results documented in `/docs/infrastructure/lambda-powertuning-results.md`:
- 66% memory reduction achieved
- Cold start optimization

---

## Authentication

### AWS Cognito + Google OAuth

- User pools with Google federation
- Crystal PSAD domain (`hd=psd401.net`)
- Role extraction from Cognito groups
- Session management via NextAuth v5

### Key Files

| File | Purpose |
|------|---------|
| `/auth.ts` | NextAuth configuration |
| `/lib/auth/` | Authentication utilities |
| `/docs/diagrams/05-authentication-flow.md` | Visual flow diagram |

---

## Secrets Management

### AWS Secrets Manager

All credentials stored in Secrets Manager with structured naming:

```
psd-agent/{env}/google-oauth-client
psd-agent/{env}/internal-api-key
psd-agent/{env}/gcp-dwd-config
psd-agent/{env}/agent-gateway
psd-agent-creds/{env}/user/{email}/google-workspace-user
```

### Access Pattern

- IAM role grants least-privilege access
- 5-minute cache for settings
- No secrets in environment variables or code

---

## Storage

### S3 Buckets

| Bucket | Purpose |
|--------|---------|
| Document uploads | Knowledge repository files |
| Atrium content | Published content storage |
| Attachments | Nexus chat attachments |

### Storage Optimization

- Lifecycle policies for cost management
- Presigned URLs for large file access
- Versioning enabled for content buckets

See `/docs/features/s3-storage-optimization.md` for details.

---

## Monitoring

### CloudWatch

- Structured JSON logging via `/lib/logger.ts`
- Request ID tracing across all operations
- OpenTelemetry (ADOT) for distributed tracing

### Dashboards

- Per-environment CloudWatch dashboards
- Custom metrics for AI usage
- Alarm thresholds for reliability

### Alarm Delivery

All agent platform alarms use **dual-topic delivery** to prevent silent failures:

1. **Dedicated topic**: `psd-agent-alarms-{env}` with optional email subscription
2. **Shared topic**: `aistudio-{env}-monitoring-alarms` (cross-stack, always has confirmed subscriber)

This pattern exists because SNS email subscriptions can silently disappear. In production (2026-07-24), an email subscription was created but nobody clicked the confirmation link; SNS deleted it after 3 days while CloudFormation still showed `CREATE_COMPLETE`. The router DLQ alarm fired for 36 days with zero subscribers, and 50 user messages died in the DLQ unnoticed.

**Implementation**: The `notifyAgentAlarm()` helper in `/infra/lib/agent-platform-stack.ts` ensures every alarm publishes to both topics. The helper now throws at synth time if called before `agentAlarmTargets` is populated—preventing the previous `?? []` fallback that could silently produce a valid synth with no alarm actions.

**Self-Monitoring**: The `AgentAlarmDeliveryFailures` alarm watches `AWS/SNS NumberOfNotificationsFailed` on the shared monitoring topic. If SNS publish fails, the alarm fires—catching the case where an alarm is in ALARM state but nobody receives notification. This alarm itself publishes to the same dual topics.

**Tests**: `/infra/test/agent-alarm-delivery.test.ts` validates that every notifying alarm reaches the shared topic and that `notifyAgentAlarm()` refuses to wire before targets exist.

#### Threshold Tuning

Agent platform alarms are tuned to eliminate false positives while preserving real-fault detection:

**Dead-Boot Alarm**: Uses threshold ≥2 across 3 consecutive periods (previously ≥1 over 1 period). A microVM that logs `BUILD_MARKER` just before a period boundary logs `BootOk` just after it, showing a transient +1 difference. Over 7 days of production, `BuildMarkerBoot` and `BootOk` were exactly equal (9562 each) while 18% of periods crossed the old threshold—about 52 pages a day. A straddle self-corrects in the next period, so requiring the deficit to persist across 3 periods eliminates timing artifacts. A genuine r10 dead boot (gateway/provider/model resolution failing outright) affects every boot in the window and crosses immediately.

**Cron Error Alarm**: Watches a filtered metric (`CronUnexpectedInvokeError`) that excludes `JobLockAcquisitionError`. The cron handler intentionally throws this error so Lambda re-invokes the fire—it is control flow, not a failure. Over 24h of production, 100% of cron invoke errors were this retry mechanism, none were genuine. The metric filter `"Invoke Error" -JobLockAcquisitionError` ensures new/unknown error types still alarm immediately.

Neither change makes the platform quieter about real faults: the DLQ, delivery, throttle, and schedule-rejection alarms are untouched, and both alarms still fire on the conditions they were written for.

### Key Files

| File | Purpose |
|------|---------|
| `/lib/monitoring/` | Monitoring utilities |
| `/infra/lib/constructs/monitoring/` | Dashboard definitions |
| `/infra/test/agent-alarm-delivery.test.ts` | Alarm routing validation |
| `/docs/operations/PERFORMANCE_TESTING.md` | Load testing procedures |

---

## Security

### K-12 Content Safety

**Documentation**: `/docs/features/k12-content-safety.md`

Amazon Bedrock Guardrails provide:
- Content filtering (violence, hate, sexual content)
- PII detection and tokenization
- Copilot/FERPA/CIPA compliance support
- Real-time SNS alerts for violations

### IAM Least Privilege

**Documentation**: `/docs/security/USING_IAM_SECURITY.md`

- Tag-based access control
- Role-filtered capabilities
- Isolated agent execution

### Network Security

- VPC with public/private/isolated subnets
- Security groups for each tier
- VPC endpoints for AWS services

See `/docs/diagrams/02-vpc-network-topology.md` for network diagram.

---

## Deployment Safety

### Pre-Deployment Checklist

From `/infra/DEPLOYMENT_SAFETY_CHECKLIST.md`:

1. Run `bun run lint` and `bun run typecheck`
2. Verify migrations in `/infra/database/migrations.json`
3. Run tests: `bun run test:e2e`
4. Review CDK diff
5. Check secrets are current

### Deployment Commands

**Full documentation**: `/infra/DEPLOYMENT_COMMANDS.md`

```bash
# Deploy all stacks
cd infra && bunx cdk deploy --all

# Deploy with context
bunx cdk deploy -c environment=dev

# Hotswap for fast iteration (dev only)
bunx cdk deploy --hotswap
```

---

## Testing Infrastructure

### Infrastructure Tests

**Location**: `/infra/test/`

| Test File | Purpose |
|-----------|---------|
| `*stack*.test.ts` | Stack synthesis tests |
| `*lambda*.test.ts` | Lambda configuration tests |
| `*vpc*.test.ts` | Network topology tests |

Run: `cd infra && bun test`

---

## CI/CD Workflows

**Location**: `.github/workflows/`

AI Studio uses GitHub Actions for continuous integration and deployment. Non-trivial workflows consume reusable workflows from the org repository (`PSD401/.github`) for consistency across district projects.

### Reusable Workflow Consumers

| Workflow | Reusable Source | Purpose |
|----------|-----------------|---------|
| `claude-code-review.yml` | `PSD401/.github/.github/workflows/reusable-claude-review.yml@main` | AI-assisted PR review |
| `openwiki-update.yml` | `PSD401/.github/.github/workflows/reusable-openwiki.yml@main` | Automated documentation regeneration |

### Caller Pattern

Caller workflows are minimal—granting permissions and passing configuration:

```yaml
jobs:
  openwiki:
    permissions:
      contents: write
      pull-requests: write
    uses: PSD401/.github/.github/workflows/reusable-openwiki.yml@main
    with:
      base_branch: dev
    secrets: inherit
```

Benefits:
- Single source of truth for workflow logic
- Centralized security and dependency updates
- Reduced boilerplate in repository callers

### Index of Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push to dev, PR | Lint, typecheck, tests |
| `claude-code-review.yml` | PR opened/ready | AI-assisted code review |
| `openwiki-update.yml` | Push to dev (excluding openwiki/**), weekly schedule | Regenerate OpenWiki docs |
| `agent-eval-nightly.yml` | Nightly schedule | Agent skill evaluation |
| `codeql.yml` | Weekly schedule | Security analysis |

---

## Key Source Files

| File/Directory | Purpose |
|----------------|---------|
| `/infra/bin/infra.ts` | CDK app entrypoint |
| `/infra/lib/stacks/` | Stack definitions |
| `/infra/lib/constructs/` | Reusable patterns |
| `/infra/database/` | Migrations |
| `/infra/lambdas/` | Lambda function code |
| `/infra/policies/` | Cedar policies |
| `/infra/agent-image/` | Agent container |
| `/.github/workflows/` | CI/CD workflows |

---

## Related Concepts

- **[architecture/overview.md](../architecture/overview.md)** — Overall architecture
- **[data-models/overview.md](../data-models/overview.md)** — Database schema
- **[agent-platform/overview.md](../agent-platform/overview.md)** — Agent-specific infrastructure
