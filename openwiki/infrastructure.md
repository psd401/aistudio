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
| Agent | `agent_sessions`, `agent_messages`, `agent_tool_invocations` |

**Schema Source**: `/lib/db/schema/tables/`

## Agent Platform

### Components

- **ECR Repository**: Docker image storage for agent container
- **AgentCore Runtime**: AWS managed agent execution
- **S3 Workspace Buckets**: Agent file storage
- **DynamoDB Tables**: 6 tables for agent state management
- **Router Lambda**: Google Chat integration

### DynamoDB Tables

| Table | Purpose |
|-------|---------|
| `AgentSessions` | Active agent sessions |
| `AgentMessages` | Message history |
| `AgentToolInvocations` | Tool call records |
| `AgentFailures` | Failure tracking |
| `AgentHealthSnapshots` | Health monitoring |
| `AgentSkills` | Skill registry |

**Source**: `/infra/lib/agent-platform-stack.ts`

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
| Deploy Commands | `/infra/DEPLOYMENT_COMMANDS.md` |
| Safety Checklist | `/infra/DEPLOYMENT_SAFETY_CHECKLIST.md` |
