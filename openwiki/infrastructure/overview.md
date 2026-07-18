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
| `agent-router/` | Agent request routing |

### Agent Platform Lambdas

| Lambda | Purpose |
|--------|---------|
| `agent-mint/` | DWD token broker (isolated security) |
| `hyperframes-render/` | HTML to video rendering |

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

### Key Files

| File | Purpose |
|------|---------|
| `/lib/monitoring/` | Monitoring utilities |
| `/infra/lib/constructs/monitoring/` | Dashboard definitions |
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

---

## Related Concepts

- **[architecture/overview.md](../architecture/overview.md)** — Overall architecture
- **[data-models/overview.md](../data-models/overview.md)** — Database schema
- **[agent-platform/overview.md](../agent-platform/overview.md)** — Agent-specific infrastructure
