# AWS Service Architecture

High-level view of all AWS services and their interactions in the AI Studio application.

## Complete System Architecture

```mermaid
graph TB
    subgraph "Client Layer"
        BROWSER[Web Browser]
        MOBILE[Mobile Browser]
    end

    subgraph "CDN & DNS"
        R53[Route 53<br/>DNS]
        CF[CloudFront<br/>Optional CDN]
    end

    subgraph "Load Balancing"
        ALB[Application<br/>Load Balancer<br/>HTTPS/HTTP/2]
        WAF[AWS WAF<br/>Web Firewall]
    end

    subgraph "Compute - Frontend"
        ECS[ECS Fargate<br/>Next.js 15 SSR<br/>Auto-scaling: 2-10 tasks]
        ECR[Elastic Container<br/>Registry<br/>Docker Images]
    end

    subgraph "Compute - Background Processing"
        L_FILE[Lambda: file-processor<br/>1024 MB]
        L_URL[Lambda: url-processor<br/>1024 MB]
        L_TEXTRACT[Lambda: textract-processor<br/>2048 MB]
        L_EMBED[Lambda: embedding-generator<br/>1024 MB]
        L_DBINIT[Lambda: db-init<br/>512 MB]
        L_SCHED[Lambda: scheduled-executor<br/>512 MB]
    end

    subgraph "Queuing"
        SQS_FILE[SQS: file-processing-queue]
        SQS_DLQ[SQS: dead-letter-queue]
    end

    subgraph "Database"
        AURORA[Aurora Serverless v2<br/>PostgreSQL 15<br/>Min: 0.5 ACU, Max: 4 ACU]
        RDS_DATA[RDS Data API<br/>HTTP Interface]
        SECRETS[Secrets Manager<br/>DB Credentials]
    end

    subgraph "Storage"
        S3_DOCS[S3: documents-bucket<br/>Lifecycle: Intelligent-Tiering]
        S3_LOGS[S3: logs-bucket<br/>30-day retention]
    end

    subgraph "Authentication"
        COGNITO[Cognito User Pool<br/>OAuth 2.0]
        GOOGLE[Google OAuth<br/>Federated Identity]
    end

    subgraph "AI Services"
        BEDROCK[Amazon Bedrock<br/>Claude, Llama]
        OPENAI[OpenAI API<br/>GPT-5, GPT-4]
        GEMINI[Google AI<br/>Gemini Models]
        TEXTRACT[Amazon Textract<br/>PDF/Image OCR]
    end

    subgraph "Monitoring & Observability"
        CW_LOGS[CloudWatch Logs<br/>Centralized Logging]
        CW_METRICS[CloudWatch Metrics<br/>Custom + AWS Metrics]
        CW_DASH[CloudWatch Dashboards<br/>115+ Widgets]
        ADOT[AWS Distro for<br/>OpenTelemetry<br/>Distributed Tracing]
        CW_ALARMS[CloudWatch Alarms<br/>Error/Latency Alerts]
        SNS[SNS Topics<br/>Alert Notifications]
    end

    subgraph "Configuration"
        SSM[Systems Manager<br/>Parameter Store<br/>Cross-stack Config]
        EVENTBRIDGE[EventBridge<br/>Scheduled Events]
    end

    %% Client flow
    BROWSER --> R53
    MOBILE --> R53
    R53 --> CF
    CF --> WAF
    WAF --> ALB
    ALB --> ECS

    %% ECS dependencies
    ECR --> ECS
    ECS --> RDS_DATA
    RDS_DATA --> AURORA
    SECRETS --> RDS_DATA
    ECS --> S3_DOCS
    ECS --> COGNITO
    COGNITO --> GOOGLE
    ECS --> BEDROCK
    ECS --> OPENAI
    ECS --> GEMINI
    ECS --> SSM

    %% Background processing
    S3_DOCS -->|S3 Event| SQS_FILE
    SQS_FILE --> L_FILE
    L_FILE --> S3_DOCS
    L_FILE --> RDS_DATA
    L_FILE -->|failure| SQS_DLQ

    ECS -->|URL processing| L_URL
    L_URL --> RDS_DATA

    L_FILE -->|PDF/Image| TEXTRACT
    L_TEXTRACT --> TEXTRACT
    L_TEXTRACT --> RDS_DATA

    L_FILE -->|Generate embeddings| L_EMBED
    L_EMBED --> BEDROCK
    L_EMBED --> RDS_DATA

    %% Scheduled tasks
    EVENTBRIDGE --> L_SCHED
    L_SCHED --> ECS

    %% Database init
    L_DBINIT --> AURORA

    %% Monitoring
    ECS --> CW_LOGS
    L_FILE --> CW_LOGS
    L_URL --> CW_LOGS
    ALB --> CW_LOGS

    ECS --> ADOT
    AURORA --> CW_METRICS
    ALB --> CW_METRICS
    ECS --> CW_METRICS
    L_FILE --> CW_METRICS

    CW_METRICS --> CW_DASH
    CW_LOGS --> CW_DASH
    CW_METRICS --> CW_ALARMS
    CW_ALARMS --> SNS

    classDef frontend fill:#c8e6c9,stroke:#388e3c,stroke-width:2px
    classDef backend fill:#fff9c4,stroke:#f57f17,stroke-width:2px
    classDef data fill:#e1f5ff,stroke:#0288d1,stroke-width:2px
    classDef ai fill:#f8bbd0,stroke:#c2185b,stroke-width:2px
    classDef monitoring fill:#d1c4e9,stroke:#7e57c2,stroke-width:2px

    class BROWSER,MOBILE,R53,CF,ALB,WAF frontend
    class ECS,ECR,L_FILE,L_URL,L_TEXTRACT,L_EMBED,L_DBINIT,L_SCHED,SQS_FILE backend
    class AURORA,RDS_DATA,SECRETS,S3_DOCS,COGNITO,GOOGLE data
    class BEDROCK,OPENAI,GEMINI,TEXTRACT ai
    class CW_LOGS,CW_METRICS,CW_DASH,ADOT,CW_ALARMS,SNS monitoring
```

## Service Breakdown by Category

### Compute Services

| Service | Purpose | Configuration | Monthly Cost (Dev) |
|---------|---------|---------------|-------------------|
| **ECS Fargate** | Next.js SSR frontend | 0.5 vCPU, 1 GB RAM<br/>Auto-scale: 2-10 tasks | ~$30-60 |
| **Lambda Functions** | Async processing | Node.js 20.x<br/>512 MB - 2048 MB | ~$10-15 |
| **ECR** | Container images | Scan on push enabled | ~$2-3 |

### Database & Storage

| Service | Purpose | Configuration | Monthly Cost (Dev) |
|---------|---------|---------------|-------------------|
| **Aurora Serverless v2** | PostgreSQL database | Min: 0.5 ACU, Max: 4 ACU<br/>Auto-pause: 5 min idle | ~$15-25 (with pause) |
| **RDS Data API** | HTTP database access | Serverless, pay-per-request | ~$5-8 |
| **S3** | Document/log storage | Intelligent-Tiering<br/>Lifecycle rules | ~$3-5 |
| **Secrets Manager** | API keys, credentials | Auto-rotation enabled | ~$2-3 |

### AI & ML Services

| Service | Purpose | Pay-Per-Use Cost |
|---------|---------|------------------|
| **Amazon Bedrock** | Claude 3.5 Sonnet<br/>Llama 3.1 models | Input: $3/M tokens<br/>Output: $15/M tokens |
| **OpenAI API** | GPT-5, GPT-4 models | GPT-5: $2.50/M in, $10/M out<br/>GPT-4: $5/M in, $15/M out |
| **Google AI** | Gemini 1.5 Pro | Input: $1.25/M tokens<br/>Output: $5/M tokens |
| **Amazon Textract** | PDF/Image OCR | $1.50 per 1,000 pages |

### Monitoring Services

| Service | Purpose | Configuration | Monthly Cost |
|---------|---------|---------------|--------------|
| **CloudWatch Logs** | Centralized logging | 7-day retention (dev)<br/>30-day (prod) | ~$5-10 |
| **CloudWatch Metrics** | Performance monitoring | Custom + AWS metrics | ~$3-5 |
| **CloudWatch Dashboards** | Visualization | 115+ widgets across services | $3/dashboard |
| **ADOT** | Distributed tracing | Lambda layer + ECS sidecar | Included |
| **SNS** | Alert notifications | Email + SMS alerts | ~$1-2 |

## Data Flow Patterns

### Real-Time Chat Request
```
1. User sends message → ALB
2. ALB routes → ECS Fargate task
3. ECS validates session → Cognito
4. ECS fetches conversation → RDS Data API → Aurora
5. ECS calls AI provider → Bedrock/OpenAI/Gemini
6. AI streams response → ECS → ALB → User (Server-Sent Events)
7. ECS saves message + tokens → RDS Data API
```

**Latency Breakdown**:
- ALB → ECS: 2-3ms
- Session validation: 5-10ms (cached)
- Database query: 10-15ms
- AI model (first token): 200-500ms
- Streaming: Real-time (<100ms chunks)

### Document Upload & Processing
```
1. User uploads file → ECS
2. ECS validates + generates presigned URL → S3
3. Browser uploads directly → S3
4. S3 Event Notification → SQS
5. SQS triggers → file-processor Lambda
6. Lambda downloads → processes → chunks text
7. If PDF/image → textract-processor Lambda
8. Textract extracts text → Lambda
9. Lambda triggers → embedding-generator
10. Embedding generator → Bedrock (embeddings API)
11. Embeddings stored → Aurora (pgvector)
12. Status updates → Aurora (job_status table)
```

**Processing Time**:
- 1 MB text file: 2-5 seconds
- 10 MB PDF (100 pages): 30-60 seconds
- 50 MB PDF (500 pages): 3-5 minutes

### Scheduled Task Execution
```
1. EventBridge triggers → scheduled-executor Lambda
2. Lambda generates JWT token → Secrets Manager
3. Lambda calls ECS endpoint → ALB → ECS
4. ECS validates JWT → processes task
5. ECS executes Assistant Architect chain
6. Results saved → Aurora
7. Completion notification → SNS (optional)
```

**Schedule Examples**:
- Daily reports: `cron(0 6 * * ? *)` (6 AM UTC)
- Weekly summaries: `cron(0 9 ? * MON *)`
- Hourly sync: `rate(1 hour)`

## High Availability Configuration

### ECS Fargate
- **Multi-AZ**: Tasks distributed across 2 AZs
- **Auto-scaling**: CPU > 70% → scale out
- **Health checks**: ALB checks `/health` endpoint every 30s
- **Deployment**: Rolling update with 50% capacity maintained

### Aurora Serverless v2
- **Multi-AZ**: Automatic replica in second AZ
- **Failover**: < 30 seconds to promote replica
- **Backup**: Automated daily snapshots (7-day retention dev, 30-day prod)
- **Point-in-time recovery**: 5-minute granularity

### Application Load Balancer
- **Multi-AZ**: Nodes in both availability zones
- **SSL/TLS**: Certificate auto-renewal via ACM
- **Connection draining**: 300-second timeout
- **Stickiness**: Session-based routing enabled

## Security Architecture

### Network Security
- **VPC**: Isolated network (10.0.0.0/16)
- **Security Groups**: Least-privilege rules
- **NACLs**: Subnet-level firewall (default allow)
- **WAF**: SQL injection, XSS protection

### Data Security
- **Encryption at Rest**: All S3 buckets (SSE-S3)
- **Encryption in Transit**: TLS 1.2+ everywhere
- **Database**: Encrypted with AWS KMS
- **Secrets**: Automatic rotation (30-90 days)

### IAM Security
- **Service Roles**: Tag-based least privilege
- **MFA**: Required for production deployments
- **Permission Boundaries**: Prevent privilege escalation
- **Access Analyzer**: Continuous policy validation

## Cost Optimization Strategies

### Implemented
1. **Aurora Auto-Pause**: Scales to 0 ACU when idle (dev only)
2. **ECS Spot**: 70% savings on non-critical workloads
3. **Lambda Right-Sizing**: PowerTuning reduced memory 66%
4. **S3 Lifecycle**: Intelligent-Tiering after 30 days
5. **VPC Consolidation**: Single VPC saves $90/month (2 NAT gateways)

### Future Opportunities
1. **Graviton2**: ARM-based instances (20% cost savings)
2. **Reserved Instances**: 1-year commit for RDS (40% savings)
3. **Savings Plans**: Compute commitment (17% savings)
4. **CloudFront**: Cache static assets (reduce ECS load)
5. **Lambda Provisioned Concurrency**: Eliminate cold starts (cost vs latency trade-off)

## Monitoring Dashboards

### Consolidated Dashboard (115+ Widgets)
- **ECS Metrics**: CPU, memory, task count, deployment status
- **Lambda Metrics**: Invocations, errors, duration, cold starts
- **RDS Metrics**: Connections, CPU, storage, replication lag
- **ALB Metrics**: Request count, latency, 4xx/5xx errors
- **AI Usage**: Token consumption, model latency, error rates
- **Cost Tracking**: Daily spend by service

**Access**: AWS Console → CloudWatch → Dashboards → "AIStudio-Consolidated-Dev"

---

**Last Updated**: November 2025
**Total AWS Services**: 20+
**Monthly Dev Cost**: ~$100-150
**Monthly Prod Cost**: ~$200-300 (without AI usage)
