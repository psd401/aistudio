# AI Studio Infrastructure

AWS CDK infrastructure as code for AI Studio application using TypeScript.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Stack Structure](#stack-structure)
- [Deployment Guide](#deployment-guide)
- [CDK Commands](#cdk-commands)
- [Environment Configuration](#environment-configuration)
- [Development Workflow](#development-workflow)

## Architecture Overview

AI Studio infrastructure consists of 7 CDK stacks deployed in a specific order:

```
1. DatabaseStack → Aurora Serverless v2 + VPC
2. AuthStack → Cognito User Pool
3. StorageStack → S3 buckets
4. Document ProcessingStack → Lambdas + SQS
5. FrontendStack → ECS Fargate + ALB
6. SchedulingStack → EventBridge + Lambda
7. MonitoringStack → CloudWatch Dashboards
```

See `/docs/diagrams/01-cdk-stack-dependencies.md` for complete dependency graph.

## Stack Structure

```
/infra
├── bin/
│   └── infra.ts                    # CDK app entry point
├── lib/
│   ├── stacks/                     # Stack definitions
│   │   ├── database-stack.ts
│   │   ├── auth-stack.ts
│   │   ├── storage-stack.ts
│   │   ├── document-processing-stack.ts
│   │   ├── frontend-stack.ts
│   │   ├── scheduling-stack.ts
│   │   └── monitoring-stack.ts
│   ├── constructs/                 # Reusable CDK patterns
│   │   ├── security/               # IAM, secrets, roles
│   │   ├── network/                # VPC, shared networking
│   │   ├── compute/                # Lambda, ECS patterns
│   │   ├── monitoring/             # CloudWatch, ADOT
│   │   └── config/                 # Environment configs
│   └── config/
│       ├── environment-config.ts   # Per-environment settings
│       └── common-config.ts        # Shared configuration
├── database/
│   ├── schema/                     # SQL migrations
│   │   ├── 001_initial_schema.sql
│   │   ├── 002_nexus_features.sql
│   │   └── ...
│   └── lambda/
│       └── db-init-handler.ts      # Database initialization Lambda
└── lambdas/                        # Lambda function code
    ├── file-processor/
    ├── textract-processor/
    ├── embedding-generator/
    ├── schedule-executor/
    └── document-processor-v2/
```

## Deployment Guide

### Prerequisites

1. **AWS CLI configured:**
```bash
aws configure
# Enter credentials for target account
```

2. **Node.js 20.x:**
```bash
node --version  # Should be v20.x
```

3. **CDK Bootstrap (one-time):**
```bash
cd infra
npx cdk bootstrap aws://ACCOUNT-ID/us-west-2
```

### First-Time Deployment

Deploy stacks in dependency order:

```bash
cd infra

# 1. Database (creates VPC + Aurora)
npx cdk deploy AIStudio-DatabaseStack-Dev

# 2. Auth (creates Cognito)
npx cdk deploy AIStudio-AuthStack-Dev

# 3. Storage (creates S3 buckets)
npx cdk deploy AIStudio-StorageStack-Dev

# 4. Document Processing (creates Lambdas)
npx cdk deploy AIStudio-DocumentProcessingStack-Dev

# 5. Frontend (creates ECS + ALB)
npx cdk deploy AIStudio-FrontendStack-Dev

# 6. Scheduling (creates EventBridge)
npx cdk deploy AIStudio-SchedulingStack-Dev

# 7. Monitoring (creates CloudWatch dashboards)
npx cdk deploy AIStudio-MonitoringStack-Dev
```

**Or deploy all at once:**
```bash
npx cdk deploy --all --require-approval never
```

### Subsequent Deployments

Deploy only changed stacks:

```bash
# Check what changed
npx cdk diff AIStudio-FrontendStack-Dev

# Deploy single stack
npx cdk deploy AIStudio-FrontendStack-Dev

# Deploy multiple specific stacks
npx cdk deploy AIStudio-FrontendStack-Dev AIStudio-DatabaseStack-Dev
```

## CDK Commands

### Synthesis & Validation

```bash
# Generate CloudFormation templates
npx cdk synth

# Validate all stacks without deploying
npx cdk synth --all

# Show diff between deployed and local
npx cdk diff

# Diff specific stack
npx cdk diff AIStudio-FrontendStack-Dev
```

### Deployment

```bash
# Deploy with approval prompts
npx cdk deploy AIStudio-FrontendStack-Dev

# Deploy without prompts (CI/CD)
npx cdk deploy AIStudio-FrontendStack-Dev --require-approval never

# Deploy with specific parameters
npx cdk deploy AIStudio-FrontendStack-Dev \
  --parameters DatabaseMinCapacity=0.5 \
  --parameters DatabaseMaxCapacity=2

# Deploy to different region
npx cdk deploy --all --region us-east-1
```

### Destroy

```bash
# Destroy single stack
npx cdk destroy AIStudio-FrontendStack-Dev

# Destroy all stacks (WARNING: deletes all data)
npx cdk destroy --all

# Destroy in reverse dependency order
npx cdk destroy AIStudio-MonitoringStack-Dev
npx cdk destroy AIStudio-SchedulingStack-Dev
npx cdk destroy AIStudio-FrontendStack-Dev
npx cdk destroy AIStudio-DocumentProcessingStack-Dev
npx cdk destroy AIStudio-StorageStack-Dev
npx cdk destroy AIStudio-AuthStack-Dev
npx cdk destroy AIStudio-DatabaseStack-Dev
```

### List & Metadata

```bash
# List all stacks
npx cdk list

# Show stack metadata
npx cdk metadata AIStudio-FrontendStack-Dev

# Watch deployment progress
npx cdk deploy AIStudio-FrontendStack-Dev --watch
```

## Environment Configuration

### Environment Files

Located in `/infra/lib/config/environment-config.ts`:

```typescript
export const environmentConfigs: Record<Environment, EnvironmentConfig> = {
  dev: {
    database: {
      minCapacity: 0.5,    // Auto-pause enabled
      maxCapacity: 2,
      autoPause: true,
      autoPauseDelay: 300  // 5 minutes
    },
    frontend: {
      desiredCount: 1,
      minCapacity: 1,
      maxCapacity: 3,
      cpu: 1024,
      memory: 2048
    }
  },
  staging: {
    database: {
      minCapacity: 1,
      maxCapacity: 4,
      autoPause: false     // Always-on
    },
    frontend: {
      desiredCount: 2,
      minCapacity: 2,
      maxCapacity: 10
    }
  },
  prod: {
    database: {
      minCapacity: 2,      // Higher baseline
      maxCapacity: 8,
      autoPause: false,
      backupRetention: 30  // 30 days
    },
    frontend: {
      desiredCount: 3,
      minCapacity: 3,
      maxCapacity: 20,
      enableFargateSpot: false  // On-demand only
    }
  }
};
```

### Switching Environments

```bash
# Deploy to staging
export ENVIRONMENT=staging
npx cdk deploy --all

# Deploy to production
export ENVIRONMENT=prod
npx cdk deploy --all
```

## Development Workflow

### Local Development

```bash
# 1. Make infrastructure changes
vim lib/stacks/frontend-stack.ts

# 2. Compile TypeScript
npm run build

# Or watch mode
npm run watch

# 3. Synthesize to validate
npx cdk synth AIStudio-FrontendStack-Dev

# 4. Deploy to dev
npx cdk deploy AIStudio-FrontendStack-Dev
```

### Testing

```bash
# Run CDK tests
npm test

# Run specific test file
npm test -- database-stack.test.ts

# Test with coverage
npm test -- --coverage
```

### Debugging

```bash
# Enable verbose logging
npx cdk deploy --verbose

# Enable CDK debug mode
CDK_DEBUG=true npx cdk deploy

# Validate CloudFormation template
npx cdk synth AIStudio-FrontendStack-Dev > template.yaml
aws cloudformation validate-template --template-body file://template.yaml
```

## Best Practices

### Security

1. **Use ServiceRoleFactory for all IAM roles:**
```typescript
import { ServiceRoleFactory } from './constructs/security';

const role = ServiceRoleFactory.createLambdaRole(this, 'MyFunctionRole', {
  functionName: 'my-function',
  environment: props.environment,
  s3Buckets: ['bucket-name'],  // Auto-scoped with tags
});
```

2. **Tag all resources:**
```typescript
Tags.of(this).add('Environment', props.environment);
Tags.of(this).add('ManagedBy', 'cdk');
Tags.of(this).add('Project', 'aistudio');
```

3. **Use Secrets Manager for secrets:**
```typescript
const secret = new Secret(this, 'MySecret', {
  secretName: `aistudio/${props.environment}/my-secret`,
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: 'admin' }),
    generateStringKey: 'password'
  }
});
```

### Performance

1. **Use VPCProvider for shared VPC:**
```typescript
import { VPCProvider } from './constructs/network';

const vpc = VPCProvider.getOrCreate(this, environment, config);
```

2. **Right-size Lambda memory** (use PowerTuning results):
```typescript
new Function(this, 'MyFunction', {
  memorySize: 1024,  // Not 3GB
  timeout: Duration.seconds(300)
});
```

3. **Enable auto-pause for dev Aurora:**
```typescript
serverlessV2ScalingConfiguration: {
  minCapacity: 0.5,
  maxCapacity: 2
},
autoPause: true,  // Dev only
autoPauseDelay: 300
```

### Cost Optimization

1. **Use Fargate Spot for non-critical workloads:**
```typescript
capacityProviderStrategies: [{
  capacityProvider: 'FARGATE_SPOT',
  weight: 70  // 70% spot, 30% on-demand
}]
```

2. **Lifecycle policies for S3:**
```typescript
lifecycleRules: [{
  transitions: [{
    storageClass: StorageClass.INTELLIGENT_TIERING,
    transitionAfter: Duration.days(30)
  }]
}]
```

3. **VPC Endpoints to reduce NAT costs:**
```typescript
// Adds S3, DynamoDB, and 14+ interface endpoints
VPCProvider.createVpcEndpoints(vpc, this);
```

## Troubleshooting

### Common Issues

**Issue: Stack deployment fails with "Resource already exists"**
```bash
# Update existing stack
npx cdk deploy AIStudio-FrontendStack-Dev --force
```

**Issue: Parameter {X} not found in SSM**
```bash
# Deploy dependency stack first
npx cdk deploy AIStudio-DatabaseStack-Dev
# Then deploy dependent stack
npx cdk deploy AIStudio-FrontendStack-Dev
```

**Issue: Lambda runs out of memory**
```bash
# Increase memory in stack definition
memorySize: 1024  # Was 512
```

**Issue: ECS tasks fail health checks**
```bash
# Check health check endpoint
curl http://task-ip:3000/api/health

# Increase timeout
healthCheck: {
  timeout: Duration.seconds(10)  # Was 5
}
```

### CloudFormation Events

```bash
# Watch stack events in real-time
aws cloudformation describe-stack-events \
  --stack-name AIStudio-FrontendStack-Dev \
  --max-items 20

# Get stack status
aws cloudformation describe-stacks \
  --stack-name AIStudio-FrontendStack-Dev \
  --query 'Stacks[0].StackStatus'
```

## Related Documentation

- [Deployment Guide](../docs/DEPLOYMENT.md)
- [CDK Stack Dependencies](../docs/diagrams/01-cdk-stack-dependencies.md)
- [VPC Network Topology](../docs/diagrams/02-vpc-network-topology.md)
- [AWS Service Architecture](../docs/diagrams/03-aws-service-architecture.md)
- [Architecture Overview](../docs/ARCHITECTURE.md)

## References

- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
- [CDK Patterns](https://cdkpatterns.com/)
- [Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)

---

**Last Updated**: November 2025
**CDK Version**: 2.x
**Node.js Version**: 20.x
**Total Stacks**: 7
**Deployment Time**: ~45 minutes (first deploy), ~10 minutes (incremental)
