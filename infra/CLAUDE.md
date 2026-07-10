# Infrastructure Patterns (CDK)

Guidance for work under `/infra`. Claude Code loads this file automatically when working with files in this directory. The infra "Don't" rules remain in the root `CLAUDE.md` (Common Pitfalls section).

## VPC & Networking
**Shared VPC Architecture** (consolidated from 2 VPCs to 1):
- All stacks use `VPCProvider.getOrCreate()` for consistent networking
- DatabaseStack creates VPC, other stacks import via `Vpc.fromLookup()`
- **Subnets**: Public, Private-Application, Private-Data, Isolated
- **VPC Endpoints**: S3, DynamoDB (gateway), plus 14+ interface endpoints
- **NAT Gateways**: Managed NAT gateways in all environments
- See `/infra/lib/constructs/network/` for patterns

```typescript
import { VPCProvider } from './constructs/network'

const vpc = VPCProvider.getOrCreate(this, environment, config)
// Automatically handles VPC creation vs. import based on stack
```

## Lambda Optimization
**PowerTuning Results** (use these defaults):
- **Standard functions**: 1024 MB (66% reduction from previous 3GB)
- **Memory-intensive**: 2048 MB
- **Lightweight**: 512 MB
- All functions use **Node.js 20.x** runtime
- X-Ray tracing enabled for observability

**Lambda Best Practices**:
- Always use `ServiceRoleFactory` for IAM roles
- Enable VPC only when accessing RDS/ElastiCache
- Use environment variables for configuration
- Add CloudWatch Logs retention (7 days dev, 30 days prod)

## ECS Fargate Optimization
- **Non-critical workloads**: Fargate Spot (70% cost savings)
- **Production frontend**: Fargate on-demand with auto-scaling
- **Task sizing**: Right-sized via load testing
- **Graviton2**: Not yet enabled (future optimization)

## Monitoring & Observability
**Consolidated Monitoring** (see `/infra/lib/constructs/monitoring/`):
- **AWS Distro for OpenTelemetry (ADOT)** for distributed tracing
- **Unified CloudWatch Dashboard** with 115+ widgets across all services
- **Metrics tracked**: Lambda performance, ECS health, RDS metrics, API latency
- **Alarms**: Configured for critical thresholds (errors, latency, resource utilization)

**Access Dashboards**:
- AWS Console → CloudWatch → Dashboards → "AIStudio-Consolidated-[Environment]"

**Custom Metrics** (add via ADOT):
```typescript
// In Lambda/ECS code
import { metrics } from '@aws-lambda-powertools/metrics'

metrics.addMetric('customMetric', 'Count', 1)
```

## Cost Optimization Patterns
**Implemented Optimizations**:
1. **Aurora Serverless**: Auto-pause in dev (saves ~$44/month)
2. **ECS Spot**: 70% savings on non-critical workloads
3. **Lambda Right-Sizing**: 66% memory reduction via PowerTuning
4. **S3 Lifecycle**: Intelligent-Tiering + automatic archival
5. **VPC Endpoints**: Reduces NAT gateway data transfer costs

**Cost Monitoring**:
- AWS Cost Explorer: Track by service and environment tags
- Budget alerts configured for each environment
- Monthly cost reports automated via CloudWatch Events

## Infrastructure Security (IAM Least Privilege)
**CRITICAL**: All new Lambda/ECS roles MUST use `ServiceRoleFactory`:

```typescript
import { ServiceRoleFactory } from './constructs/security'

const role = ServiceRoleFactory.createLambdaRole(this, 'MyFunctionRole', {
  functionName: 'my-function',
  environment: props.environment,  // REQUIRED for tag-based access
  region: this.region,
  account: this.account,
  vpcEnabled: false,
  s3Buckets: ['bucket-name'],           // Auto-scoped with tags
  dynamodbTables: ['table-name'],       // Auto-scoped with tags
  sqsQueues: ['queue-arn'],             // Auto-scoped with tags
  secrets: ['secret-arn'],              // Auto-scoped with tags
})
```

**Tag-Based Access Control** (Enforced):
- All AWS resources MUST have tags: `Environment` (dev/staging/prod), `ManagedBy` (cdk)
- IAM policies enforce tag-based conditions (dev Lambda cannot access prod S3)
- Cross-environment access is blocked at IAM level
- See `/infra/lib/constructs/security/service-role-factory.ts` for patterns

**Secrets Management**:
- All secrets stored in AWS Secrets Manager (never hardcoded)
- Access via `SecretsManagerClient` from AWS SDK
- Secrets scoped by environment tags
- Automatic rotation enabled where supported
