# ADR-003: Migrate AI Streaming from Lambda Workers to Direct ECS Execution

## Status
**Implemented** - PR #340 (October 2025)

## Context

Following the migration from AWS Amplify to ECS Fargate (ADR-002), the application gained HTTP/2 streaming capabilities. However, the architecture still used Lambda workers + SQS queues for AI streaming job processing, which was originally designed to work around Amplify's limitations.

### Problem Statement

The Lambda + SQS polling architecture introduced unnecessary complexity and latency:

- **Architectural Redundancy**: ECS already handles HTTP/2 streaming; Lambda workers were no longer needed
- **Added Latency**: SQS polling introduced 1-5 second delay before job execution started
- **Increased Cost**: Lambda + SQS added ~$35-40/month (~40% of infrastructure cost)
- **Operational Overhead**: Additional infrastructure components to deploy, monitor, and maintain
- **Cold Start Issues**: Lambda cold starts impacted initial streaming responsiveness

### Technical Analysis

**Current Architecture (Lambda-based)**:
```
Client → API Route → Create Job → Queue to SQS → Lambda Worker → Stream to DB → Client Polls
         (instant)   (100ms)      (500ms-2s)      (processing)    (1s intervals)

Total latency to start: 2-5 seconds
```

**Proposed Architecture (ECS direct)**:
```
Client → API Route → ECS Streaming → Real-time Response
         (instant)    (processing)    (<100ms latency)

Total latency to start: <500ms
```

**Key Insight**: After ADR-002's ECS migration, the Lambda polling architecture was solving a problem that no longer existed (Amplify's streaming limitation). ECS can stream directly to clients via HTTP/2.

## Decision

**Migrate all AI streaming job processing to direct ECS execution**, eliminating Lambda workers and SQS queues for streaming tasks.

### Implementation

1. **Remove Infrastructure**:
   - Delete `streamingJobsWorker` Lambda function
   - Delete `streamingJobsQueue` and `streamingJobsDlq` SQS queues
   - Remove associated IAM policies and SSM parameters
   - Clean up `STREAMING_JOBS_QUEUE_URL` environment variables

2. **Retain for Background Processing**:
   - Keep Lambda + SQS for document processing (`file-processor`)
   - Keep Lambda + SQS for Textract results (`textract-processor`)
   - Keep Lambda + SQS for URL processing (`url-processor`)
   - Keep Lambda + SQS for embeddings (`embedding-generator`)
   - **Rationale**: These are truly asynchronous tasks that don't require streaming

3. **Update Code**:
   - Remove SQS message sending from API routes
   - Remove polling architecture client code
   - Use direct ECS streaming via AI SDK
   - Simplify Assistant Architect to direct execution

4. **Database Schema**:
   - Retain `ai_streaming_jobs` table for job tracking
   - Continue using for ECS job status and results
   - No schema changes required

## Decision Drivers

### 1. Cost Reduction
**Current (Lambda + SQS for streaming)**:
- Lambda invocations: $20-30/month
- SQS requests: $5-10/month
- **Total: ~$35-40/month**

**After (Direct ECS)**:
- Lambda costs: $0 (removed for streaming)
- SQS costs: $0 (removed for streaming)
- **Savings: ~$35-40/month (~40% reduction)**

### 2. Performance Improvement
**Latency Reduction**:
- Queue delay: **-500ms to -2s** (eliminated)
- Lambda cold start: **-100ms to -1s** (eliminated)
- Polling interval: **-1s** (real-time streaming)
- **Total improvement: 1.6s to 5s faster**

**Consistency**:
- No cold start variability
- Predictable response times
- No SQS delivery delays

### 3. Architectural Simplicity
**Before (8 components)**:
1. ECS Service
2. Application Load Balancer
3. Streaming Lambda Worker
4. SQS Queue
5. SQS Dead Letter Queue
6. RDS Aurora
7. S3 Storage
8. CloudWatch Logs (multiple streams)

**After (4 components)**:
1. ECS Service
2. Application Load Balancer
3. RDS Aurora
4. S3 Storage

**50% reduction in infrastructure components**

### 4. Simplified Operations
**Fewer Moving Parts**:
- Single deployment (ECS only vs ECS + Lambda)
- Unified logging (one CloudWatch stream)
- Single scaling configuration
- Simpler troubleshooting

**Reduced Monitoring Overhead**:
- No Lambda-specific metrics
- No SQS queue depth monitoring
- No dead letter queue alerts
- Fewer CloudWatch dashboards

## Alternatives Considered

### Alternative 1: Keep Lambda + SQS for All Streaming
**Pros**:
- Already implemented and working
- Familiar architecture
- Separate scaling for background tasks

**Cons**:
- Higher cost (~$35-40/month more)
- Added latency (1-5 seconds)
- More complex architecture
- Solving a problem that no longer exists (Amplify limitations)

**Decision**: **Rejected** - Architecture is redundant after ECS migration

### Alternative 2: Hybrid - ECS for Chat, Lambda for Assistant Architect
**Pros**:
- Could isolate complex Assistant Architect processing
- Gradual migration path

**Cons**:
- Inconsistent architecture
- Still maintains Lambda complexity
- Partial cost savings only
- Confusing for developers (two execution paths)

**Decision**: **Rejected** - Consistency is more valuable than partial isolation

### Alternative 3: Step Functions for Long-Running Tasks
**Pros**:
- No timeout limits (can run for days)
- Built-in retry and checkpointing
- Notification on completion

**Cons**:
- Added complexity for feature that's rarely needed
- Most AI responses complete in <30 seconds
- Can add later if needed

**Decision**: **Deferred** - Implement only if users require tasks >15 minutes

## Consequences

### Positive Outcomes

#### Cost Savings
| Cost Component | Before | After | Savings |
|----------------|--------|-------|---------|
| Lambda invocations | $20-30/month | $0 | -$20-30/month |
| SQS requests | $5-10/month | $0 | -$5-10/month |
| **Total** | **$35-40/month** | **$0** | **~40% reduction** |

#### Performance Improvements
| Metric | Before (Lambda) | After (ECS Direct) | Improvement |
|--------|----------------|-------------------|-------------|
| Queue delay | 500ms-2s | 0ms | **-100%** |
| Cold start | 100ms-1s | 0ms | **-100%** |
| Polling latency | 1s | 0ms | **-100%** |
| **Total latency** | **2-5 seconds** | **<500ms** | **75-90% faster** |

#### Architecture Benefits
- **Simplified deployment**: Single service (ECS)
- **Unified logging**: All requests in one CloudWatch stream
- **Easier debugging**: Single execution path
- **Consistent patterns**: All streaming uses same architecture

#### Operational Benefits
- **Fewer alerts**: No Lambda/SQS-specific monitoring
- **Simpler scaling**: Only ECS auto-scaling to manage
- **Reduced maintenance**: Fewer infrastructure updates
- **Lower complexity**: 50% fewer components

### Trade-offs and Considerations

#### ECS Must Handle All Streaming Load
**Impact**: ECS service must scale to handle all concurrent streaming requests

**Mitigation**:
- Auto-scaling configured for CPU/memory thresholds
- Current configuration handles 100+ concurrent streams
- Can scale horizontally (add more tasks)
- Can scale vertically (larger task sizes)

**Monitoring**: CloudWatch alarms for high CPU/memory usage

#### Less Isolated Execution Environment
**Impact**: AI streaming runs in same containers as web application

**Analysis**:
- **Acceptable**: ECS tasks are still isolated from each other
- **Benefit**: Unified deployment and configuration
- **Risk**: Minimal - resource limits prevent runaway processes
- **Mitigation**: Container resource limits (CPU/memory)

**Decision**: Trade-off is acceptable for simplified architecture

#### No Built-in Retry for Failed Streams
**Impact**: Lambda + SQS provided automatic retry for failed jobs

**Mitigation**:
- Client-side retry logic for transient failures
- Error handling in ECS streaming code
- Database tracking of failed jobs
- Manual retry option for users

**Analysis**: Most streaming failures are non-retryable (invalid input, quota exceeded), so automatic retry provides limited value

## Implementation Details

### Infrastructure Changes (CDK)

**Removed Components**:
```typescript
// Before - in ProcessingStack
const streamingJobsWorker = new lambda.Function(this, 'StreamingJobsWorker', {
  runtime: lambda.Runtime.NODEJS_20_X,
  code: lambda.Code.fromAsset('lambdas/streaming-jobs-worker'),
  handler: 'index.handler',
  timeout: Duration.minutes(15),
  // ... IAM policies, environment vars
});

const streamingJobsQueue = new sqs.Queue(this, 'StreamingJobsQueue', {
  queueName: `aistudio-${environment}-streaming-jobs-queue`,
  // ... configuration
});

// Event source mapping
streamingJobsWorker.addEventSource(new SqsEventSource(streamingJobsQueue));
```

**After**:
```typescript
// Removed entirely from ProcessingStack
// ECS service in ECSServiceStack handles all streaming
```

### Code Changes

**Before (Polling Architecture)**:
```typescript
// API Route - Create job and queue
export async function POST(req: Request) {
  const jobId = await jobManagementService.createJob({
    source: 'assistant-architect',
    // ... job data
  });

  // Send to SQS
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: getStreamingJobsQueueUrl(),
    MessageBody: JSON.stringify({ jobId }),
  }));

  return NextResponse.json({ jobId, status: 'pending' });
}

// Client - Poll for results
for await (const update of pollJob(jobId)) {
  setContent(update.partialContent);
}
```

**After (Direct Streaming)**:
```typescript
// API Route - Stream directly
export async function POST(req: Request) {
  const { messages, modelId, provider } = await req.json();

  const result = streamText({
    model: createProviderModel(provider, modelId),
    messages,
    onFinish: async ({ text, usage }) => {
      await saveMessage(conversationId, text, usage);
    }
  });

  return result.toDataStreamResponse();
}

// Client - Real-time streaming
const { messages, append } = useChat({
  api: '/api/nexus/chat',
  streamProtocol: 'data'
});
```

### Database Schema (Unchanged)

```sql
-- ai_streaming_jobs table retained for ECS job tracking
CREATE TABLE ai_streaming_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT,
  user_id INTEGER NOT NULL,
  model_id INTEGER NOT NULL,
  status job_status NOT NULL DEFAULT 'pending',
  request_data JSONB NOT NULL,
  response_data JSONB,
  partial_content TEXT,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);
```

**Usage**: Now tracks ECS streaming jobs instead of Lambda jobs

### Deployment Process

1. **Phase 1**: Deploy infrastructure changes
   ```bash
   cd infra
   bunx cdk deploy AIStudio-ProcessingStack-Dev  # Removes Lambda/SQS
   bunx cdk deploy AIStudio-ECSServiceStack-Dev  # Removes env vars
   ```

2. **Phase 2**: Verify no orphaned resources
   ```bash
   aws lambda list-functions | grep streaming
   aws sqs list-queues | grep streaming
   # Both should return empty
   ```

3. **Phase 3**: Test streaming functionality
   - Execute Nexus Chat conversation
   - Run Model Compare
   - Test Assistant Architect tool
   - Verify real-time streaming works

## Success Metrics

### Performance Targets
- ✅ **Time-to-first-token**: <1 second (was 2-5 seconds)
- ✅ **Streaming latency**: <100ms (was 1-2 seconds)
- ✅ **Execution start time**: <500ms (was 2-5 seconds)
- ✅ **Error rate**: <1% (same as before)

### Cost Targets
- ✅ **Monthly savings**: $35-40/month
- ✅ **Cost reduction**: ~40% of streaming infrastructure
- ✅ **No performance degradation**: Achieved while reducing cost

### Operational Targets
- ✅ **Infrastructure components**: Reduced from 8 to 4
- ✅ **Deployment complexity**: Single service deployment
- ✅ **Monitoring overhead**: 50% reduction in metrics/alarms
- ✅ **Zero user-facing changes**: Seamless migration

## Monitoring and Validation

### Metrics to Track
```typescript
// CloudWatch Metrics
- ECS Service CPU Utilization
- ECS Service Memory Utilization
- ALB Request Count
- ALB Target Response Time
- Database Connection Count
- AI Provider API Latency
```

### Alerts
```typescript
// CloudWatch Alarms
- ECS CPU > 80% (scale up)
- ECS Memory > 80% (scale up)
- Error rate > 1% (investigate)
- Response time > 10s (performance issue)
```

### Validation Queries
```sql
-- Verify streaming jobs are being created
SELECT COUNT(*) as job_count, status
FROM ai_streaming_jobs
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY status;

-- Check for errors
SELECT error_message, COUNT(*)
FROM ai_streaming_jobs
WHERE status = 'failed'
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY error_message;
```

## Rollback Plan

If critical issues arise:

1. **Revert infrastructure**:
   ```bash
   git checkout <previous-commit-with-lambda>
   cd infra
   bunx cdk deploy AIStudio-ProcessingStack-Dev
   bunx cdk deploy AIStudio-ECSServiceStack-Dev
   ```

2. **Revert code changes**:
   ```bash
   git revert <commit-hash-of-migration>
   npm run build
   # Push to trigger Amplify deployment
   ```

3. **Expected downtime**: <5 minutes for infrastructure redeployment

## Related Decisions

### ADR-002: Streaming Architecture Migration
- **Relationship**: ADR-003 builds on ADR-002
- **Phase 1 (ADR-002)**: Amplify → ECS Fargate (enabled streaming)
- **Phase 2 (ADR-003)**: Lambda workers → ECS direct (simplified streaming)

### Future Considerations

#### Step Functions for Very Long Tasks
If users require AI tasks that exceed 15 minutes:
- Implement Step Functions workflow
- Email notification on completion
- Checkpointing for reliability
- Separate from real-time streaming

**Trigger**: User request for tasks >15 minutes
**Effort**: 1-2 weeks implementation
**Cost**: ~$5-10/month

#### WebSocket Support
For bidirectional real-time communication:
- User interruption of AI responses
- Real-time collaboration features
- Typing indicators

**Trigger**: User requests interactive features
**Effort**: 2-3 weeks implementation
**Compatibility**: Works with ECS architecture

## Conclusion

Migrating AI streaming from Lambda workers to direct ECS execution successfully:

- **Reduced costs**: ~$35-40/month savings (~40% reduction)
- **Improved performance**: 75-90% faster time-to-first-response
- **Simplified architecture**: 50% fewer infrastructure components
- **Better operations**: Unified deployment, logging, and monitoring
- **Zero user impact**: Seamless migration with no breaking changes

This migration demonstrates the importance of re-evaluating architectural patterns as underlying infrastructure evolves. What was necessary with Amplify (Lambda + SQS) became redundant after migrating to ECS Fargate.

**Key Learning**: Architecture should evolve as capabilities improve. Don't maintain complexity that solved yesterday's problems.

---

## References

- **Implementation**: PR #340 - Remove streaming Lambda workers
- **Related**: Issue #313 - Refactor Lambda workers for background-only processing
- **Related**: Issue #341 - Clean up dead SQS code
- **Related**: Issue #343 - Update documentation for ECS streaming
- **Prior Decision**: ADR-002 - Streaming Architecture Migration (Amplify → ECS)
- **Epic**: #305 - Streaming architecture optimization

**Decision Date**: October 2025
**Implemented**: October 2025 (PR #340)
**Status**: Production - Fully deployed and validated
