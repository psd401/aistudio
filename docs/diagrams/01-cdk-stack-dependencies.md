# CDK Stack Dependency Graph

This diagram shows the deployment order and SSM parameter dependencies between AWS CDK stacks.

## Deployment Order

```mermaid
graph TB
    subgraph "Infrastructure Foundation"
        DB[DatabaseStack]
        AUTH[AuthStack]
        STORAGE[StorageStack]
    end

    subgraph "Processing Layer"
        PROC[ProcessingStack]
        DOCPROC[DocumentProcessingStack]
        EMAIL[EmailNotificationStack]
    end

    subgraph "Frontend Layer"
        FE[FrontendStack-ECS]
    end

    subgraph "Monitoring & Optimization"
        MON[MonitoringStack]
        SCHED[SchedulerStack]
    end

    %% Dependencies
    DB --> PROC
    DB --> FE
    DB --> SCHED

    STORAGE --> PROC
    STORAGE --> DOCPROC
    STORAGE --> FE

    AUTH --> FE

    PROC --> SCHED
    DOCPROC --> SCHED

    FE --> MON
    PROC --> MON
    DOCPROC --> MON

    EMAIL -.optional.-> SCHED

    classDef foundation fill:#e1f5ff,stroke:#0288d1,stroke-width:2px
    classDef processing fill:#fff9c4,stroke:#f57f17,stroke-width:2px
    classDef frontend fill:#c8e6c9,stroke:#388e3c,stroke-width:2px
    classDef monitoring fill:#f8bbd0,stroke:#c2185b,stroke-width:2px

    class DB,AUTH,STORAGE foundation
    class PROC,DOCPROC,EMAIL processing
    class FE frontend
    class MON,SCHED monitoring
```

## SSM Parameter Store Flow

```mermaid
graph LR
    subgraph "DatabaseStack Exports"
        DB[DatabaseStack]
        DB --> |writes| SSM1["/aistudio/env/db-cluster-arn"]
        DB --> |writes| SSM2["/aistudio/env/db-secret-arn"]
        DB --> |writes| SSM3["/aistudio/env/vpc-id"]
    end

    subgraph "StorageStack Exports"
        STORAGE[StorageStack]
        STORAGE --> |writes| SSM4["/aistudio/env/documents-bucket-name"]
        STORAGE --> |writes| SSM5["/aistudio/env/documents-bucket-arn"]
    end

    subgraph "AuthStack Exports"
        AUTH[AuthStack]
        AUTH --> |writes| SSM6["/aistudio/env/cognito-user-pool-id"]
        AUTH --> |writes| SSM7["/aistudio/env/cognito-client-id"]
    end

    subgraph "Consuming Stacks"
        FE[FrontendStack]
        PROC[ProcessingStack]
        SCHED[SchedulerStack]
    end

    SSM1 --> |reads| FE
    SSM2 --> |reads| FE
    SSM3 --> |reads| FE
    SSM4 --> |reads| FE
    SSM6 --> |reads| FE
    SSM7 --> |reads| FE

    SSM1 --> |reads| PROC
    SSM2 --> |reads| PROC
    SSM4 --> |reads| PROC

    SSM1 --> |reads| SCHED
    SSM2 --> |reads| SCHED

    classDef export fill:#e1f5ff,stroke:#0288d1,stroke-width:2px
    classDef param fill:#fff9c4,stroke:#f57f17,stroke-width:2px
    classDef consumer fill:#c8e6c9,stroke:#388e3c,stroke-width:2px

    class DB,STORAGE,AUTH export
    class SSM1,SSM2,SSM3,SSM4,SSM5,SSM6,SSM7 param
    class FE,PROC,SCHED consumer
```

## Deployment Commands

### Deploy All Stacks (Recommended Order)
```bash
cd infra

# Step 1: Foundation stacks (parallel)
npx cdk deploy AIStudio-DatabaseStack-Dev AIStudio-AuthStack-Dev AIStudio-StorageStack-Dev

# Step 2: Processing layer (parallel, after foundation)
npx cdk deploy AIStudio-ProcessingStack-Dev AIStudio-DocumentProcessingStack-Dev

# Step 3: Frontend (requires foundation + processing)
npx cdk deploy AIStudio-FrontendStack-Dev

# Step 4: Monitoring (after all services deployed)
npx cdk deploy AIStudio-MonitoringStack-Dev AIStudio-SchedulerStack-Dev
```

### Deploy Single Stack (For Incremental Updates)
```bash
# Frontend only (for UI changes)
npx cdk deploy AIStudio-FrontendStack-Dev

# Database only (for schema changes)
npx cdk deploy AIStudio-DatabaseStack-Dev

# Processing only (for Lambda updates)
npx cdk deploy AIStudio-ProcessingStack-Dev
```

## Key Benefits of SSM Parameter Store Pattern

1. **Independent Deployment**: Stacks can be deployed independently without direct references
2. **Faster Iteration**: Update single stack without redeploying dependencies
3. **Cost Savings**: ~15-20 minute deployment → ~3-5 minutes for single stack
4. **Reduced Risk**: Smaller change sets reduce blast radius
5. **Multi-Environment**: Same parameter names across dev/prod with environment prefix

## Stack Descriptions

| Stack | Purpose | Deployment Time | Dependencies |
|-------|---------|-----------------|--------------|
| **DatabaseStack** | Aurora Serverless v2, VPC, RDS Data API | ~8-10 min | None |
| **AuthStack** | Cognito User Pool, Google OAuth integration | ~3-5 min | None |
| **StorageStack** | S3 buckets, lifecycle policies | ~2-3 min | None |
| **ProcessingStack** | Lambda workers, SQS queues for async processing | ~4-6 min | Database, Storage |
| **DocumentProcessingStack** | Document upload, Textract, embedding generation | ~4-6 min | Storage |
| **FrontendStack-ECS** | ECS Fargate, ALB, auto-scaling, CloudFront | ~10-12 min | Database, Auth, Storage |
| **MonitoringStack** | CloudWatch dashboards, alarms, ADOT | ~3-4 min | All services |
| **SchedulerStack** | EventBridge scheduled tasks, cron jobs | ~2-3 min | Database, Processing |

## Troubleshooting

### Stack Deployment Fails

**Symptom**: `AIStudio-FrontendStack-Dev` fails with "Parameter /aistudio/dev/db-cluster-arn not found"

**Solution**:
```bash
# Verify DatabaseStack exported parameters
aws ssm get-parameter --name "/aistudio/dev/db-cluster-arn"

# If missing, redeploy DatabaseStack
npx cdk deploy AIStudio-DatabaseStack-Dev
```

### Parameter Store Cleanup

If you need to clean up parameters for a fresh deployment:
```bash
# List all AI Studio parameters
aws ssm describe-parameters --filters "Key=Name,Values=/aistudio/"

# Delete environment-specific parameters
aws ssm delete-parameters --names \
  "/aistudio/dev/db-cluster-arn" \
  "/aistudio/dev/db-secret-arn" \
  "/aistudio/dev/documents-bucket-name"
```

---

**Last Updated**: November 2025
**Related Docs**: `/docs/DEPLOYMENT.md`, `/docs/ARCHITECTURE.md`
