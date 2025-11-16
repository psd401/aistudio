# Request Flow Diagrams

End-to-end request flows for major AI Studio features showing client → server → AI → database interactions.

## Nexus Chat - Real-Time Streaming

```mermaid
sequenceDiagram
    participant User
    participant Browser
    participant ALB as Application Load Balancer
    participant ECS as ECS Fargate (Next.js)
    participant AI as AI Provider (Bedrock/OpenAI/Gemini)
    participant Aurora as Aurora DB

    User->>Browser: Type message + click send
    Browser->>ALB: POST /api/chat/stream
    ALB->>ECS: Forward request (HTTP/2)
    ECS->>ECS: Validate session + permissions
    ECS->>Aurora: INSERT INTO nexus_messages (role: user)
    Aurora->>ECS: Message saved (id: msg-123)
    ECS->>Aurora: SELECT conversation history (last 10 messages)
    Aurora->>ECS: Return conversation context
    ECS->>AI: POST /v1/chat/completions (streaming: true)

    Note over ECS,AI: HTTP/2 Server-Sent Events (SSE) stream begins

    loop Streaming chunks
        AI-->>ECS: text chunk 1
        ECS-->>ALB: SSE event: data
        ALB-->>Browser: Forward SSE chunk
        Browser-->>User: Display partial response (live typing)
        AI-->>ECS: text chunk 2
        ECS-->>ALB: SSE event: data
        ALB-->>Browser: Forward SSE chunk
        Browser-->>User: Update display
    end

    AI->>ECS: Final chunk + finish_reason
    ECS->>Aurora: INSERT INTO nexus_messages (role: assistant, content, token_usage)
    Aurora->>ECS: Message saved
    ECS->>Aurora: INSERT INTO nexus_provider_metrics (response_time, tokens, cost)
    Aurora->>ECS: Metrics saved
    ECS->>ALB: SSE: done event
    ALB->>Browser: Stream complete
    Browser->>User: Show complete response
```

### Latency Breakdown
| Step | Time | Cumulative |
|------|------|------------|
| Browser → ALB | 20-30ms | 20-30ms |
| ALB → ECS routing | 2-3ms | 22-33ms |
| Session validation | 5-10ms | 27-43ms |
| Load conversation history | 10-15ms | 37-58ms |
| **Time to First Token** | **200-500ms** | **237-558ms** |
| Streaming chunks | 50-100ms each | Real-time |
| Save final message | 10-15ms | After stream |

## Model Compare - Side-by-Side Comparison

```mermaid
sequenceDiagram
    participant User
    participant Browser
    participant ECS as Next.js (ECS)
    participant AI1 as Model 1 (e.g., GPT-5)
    participant AI2 as Model 2 (e.g., Claude)
    participant Aurora

    User->>Browser: Select 2 models + enter prompt
    Browser->>ECS: POST /api/model-compare
    ECS->>ECS: Validate session
    ECS->>Aurora: INSERT INTO model_comparisons (user_id, prompt, model1_id, model2_id)
    Aurora->>ECS: Comparison created (id: comp-456)

    par Parallel AI Requests
        ECS->>AI1: POST /chat/completions (GPT-5)
        and ECS->>AI2: POST /messages (Claude)
    end

    par Streaming responses
        AI1-->>ECS: Stream response 1
        ECS-->>Browser: SSE channel 1
        and AI2-->>ECS: Stream response 2
        ECS-->>Browser: SSE channel 2
    end

    par Display updates
        Browser-->>User: Show GPT-5 response (left panel)
        and Browser-->>User: Show Claude response (right panel)
    end

    par Final updates
        AI1->>ECS: Complete (tokens1, time1)
        and AI2->>ECS: Complete (tokens2, time2)
    end

    ECS->>Aurora: UPDATE model_comparisons SET response1, response2, tokens_used1, tokens_used2, execution_time_ms1, execution_time_ms2
    Aurora->>ECS: Comparison saved
    ECS->>Browser: Both streams done
    Browser->>User: Show metrics table (tokens, time, cost)
```

### Performance Metrics
```
Typical Execution:
├── Model 1 (GPT-5): 2.3s, 450 tokens
├── Model 2 (Claude): 1.8s, 380 tokens
└── Total time: ~2.3s (parallel execution)

Cost Comparison:
├── GPT-5: $0.0045 (450 tokens × $10/M output)
├── Claude: $0.0057 (380 tokens × $15/M output)
└── Total: $0.0102 per comparison
```

## Document Upload & Processing Pipeline

```mermaid
graph TB
    USER[User uploads document] --> VALIDATE{File validation}
    VALIDATE -->|Valid| PRESIGN[Generate presigned S3 URL]
    VALIDATE -->|Invalid| ERROR1[Return error: Invalid file]

    PRESIGN --> CLIENT_UPLOAD[Browser uploads to S3 directly]
    CLIENT_UPLOAD --> S3[S3 Bucket]

    S3 --> S3_EVENT[S3 Event Notification]
    S3_EVENT --> SQS[SQS: file-processing-queue]

    SQS --> FILE_PROC[Lambda: file-processor]
    FILE_PROC --> CHECK_TYPE{File type?}

    CHECK_TYPE -->|PDF/Image| TEXTRACT_LAMBDA[Lambda: textract-processor]
    CHECK_TYPE -->|TXT/MD| DIRECT_CHUNK[Direct text chunking]
    CHECK_TYPE -->|DOCX| DOCX_PARSER[DOCX text extraction]

    TEXTRACT_LAMBDA --> TEXTRACT_API[AWS Textract API]
    TEXTRACT_API --> EXTRACT_TEXT[Extract text + tables]
    EXTRACT_TEXT --> DIRECT_CHUNK

    DOCX_PARSER --> DIRECT_CHUNK

    DIRECT_CHUNK --> CHUNK_TEXT[Split into 1000-token chunks]
    CHUNK_TEXT --> DB_INSERT[INSERT INTO document_chunks]
    DB_INSERT --> EMBED_TRIGGER[Trigger embedding generation]

    EMBED_TRIGGER --> EMBED_LAMBDA[Lambda: embedding-generator]
    EMBED_LAMBDA --> BEDROCK[Amazon Bedrock Embeddings API]
    BEDROCK --> EMBED_RESPONSE[Return 1536-dim vectors]
    EMBED_RESPONSE --> UPDATE_CHUNKS[UPDATE document_chunks SET embedding]

    UPDATE_CHUNKS --> COMPLETE[Mark document as processed]
    COMPLETE --> NOTIFY[Notify user: Document ready]

    ERROR1 --> END[End]
    NOTIFY --> END

    classDef upload fill:#4caf50,stroke:#388e3c,stroke-width:2px
    classDef processing fill:#ff9800,stroke:#e65100,stroke-width:2px
    classDef ai fill:#9c27b0,stroke:#7b1fa2,stroke-width:2px
    classDef complete fill:#2196f3,stroke:#1976d2,stroke-width:2px

    class USER,CLIENT_UPLOAD,S3 upload
    class FILE_PROC,TEXTRACT_LAMBDA,CHUNK_TEXT processing
    class TEXTRACT_API,BEDROCK ai
    class COMPLETE,NOTIFY complete
```

### Processing Times
| File Type | Size | Textract Time | Chunking Time | Embedding Time | Total |
|-----------|------|---------------|---------------|----------------|-------|
| **TXT** | 1 MB | 0s | 2-3s | 5-8s | **7-11s** |
| **PDF (text)** | 5 MB | 15-20s | 3-5s | 10-15s | **28-40s** |
| **PDF (scanned)** | 10 MB (100 pages) | 45-60s | 5-10s | 20-30s | **70-100s** |
| **DOCX** | 2 MB | 0s | 3-4s | 8-12s | **11-16s** |

### Cost per Document
```
Text extraction:
└── Textract: $1.50 per 1,000 pages (scanned PDFs only)

Embedding generation:
└── Bedrock Titan Embeddings: $0.0001 per 1,000 tokens
    Example: 10,000-word document (~13,000 tokens) = $0.0013

Total cost: $0.001 - $1.50 per document (depending on type)
```

## Assistant Architect Execution Flow

```mermaid
sequenceDiagram
    participant User
    participant Browser
    participant ECS as Next.js (ECS)
    participant Aurora
    participant AI as AI Provider

    User->>Browser: Click "Execute" on tool
    Browser->>ECS: POST /api/assistant-architect/execute
    ECS->>Aurora: INSERT INTO tool_executions (status: pending)
    Aurora->>ECS: Execution created (id: exec-789)
    ECS->>Browser: Return execution_id
    Browser->>User: Show "Executing..." status

    loop For each prompt in chain
        ECS->>Aurora: SELECT chain_prompt WHERE position = N
        Aurora->>ECS: Return prompt config
        ECS->>ECS: Substitute variables from previous results
        ECS->>Aurora: SELECT repositories IF prompt needs knowledge
        Aurora->>ECS: Return repository chunks (vector search)
        ECS->>Aurora: INSERT INTO prompt_results (status: running)
        Aurora->>ECS: Result created (id: result-101)
        ECS->>AI: POST with substituted prompt + knowledge
        AI->>ECS: Stream response
        ECS->>Aurora: UPDATE prompt_results (output_data, status: completed)
        Aurora->>ECS: Saved
    end

    ECS->>Aurora: UPDATE tool_executions (status: completed)
    Aurora->>ECS: Saved
    ECS->>Aurora: INSERT INTO assistant_architect_events (type: execution_complete)
    Aurora->>ECS: Event logged
    ECS->>Browser: SSE: Execution complete
    Browser->>User: Show all prompt results
```

### Variable Substitution Example
```json
{
  "prompt_1": {
    "content": "Analyze this data: {{user_input}}",
    "result": "The data shows a 25% increase in..."
  },
  "prompt_2": {
    "content": "Based on this analysis: {{prompt_1_output}}, create recommendations",
    "substituted": "Based on this analysis: The data shows a 25% increase in..., create recommendations",
    "result": "Recommended actions: 1) Increase capacity by 30%..."
  },
  "prompt_3": {
    "content": "Summarize {{prompt_1_output}} and {{prompt_2_output}}",
    "result": "Executive summary: Analysis revealed..."
  }
}
```

## Repository Knowledge Search

```mermaid
sequenceDiagram
    participant User
    participant Browser
    participant ECS
    participant Aurora
    participant Bedrock as Bedrock (Embeddings)

    User->>Browser: Search: "authentication flow"
    Browser->>ECS: POST /api/repositories/search
    ECS->>Bedrock: Generate embedding for query
    Bedrock->>ECS: Return query vector [1536 dims]
    ECS->>Aurora: Vector similarity search (pgvector)
    Note over Aurora: SELECT * FROM repository_item_chunks<br/>ORDER BY embedding <=> query_vector<br/>LIMIT 10
    Aurora->>ECS: Top 10 matching chunks
    ECS->>ECS: Rerank by relevance score
    ECS->>Browser: Return search results
    Browser->>User: Display results with snippets

    User->>Browser: Click result to view full context
    Browser->>ECS: GET /api/repositories/items/{id}
    ECS->>Aurora: SELECT full document + metadata
    Aurora->>ECS: Return complete content
    ECS->>Browser: Render document
    Browser->>User: Show full document with highlighted matches
```

### Vector Search Performance
```
Query: "how does authentication work?"
├── Embedding generation: 150-200ms
├── Vector similarity search: 50-100ms (indexed)
└── Total search time: 200-300ms

Results:
├── Top 10 chunks from 50,000+ indexed chunks
├── Relevance scores: 0.85 - 0.92 (cosine similarity)
└── Chunks span 3 different documents
```

## Scheduled Execution (EventBridge → Lambda → ECS)

```mermaid
sequenceDiagram
    participant EB as EventBridge
    participant Lambda as scheduled-executor Lambda
    participant Secrets as Secrets Manager
    participant ECS as ECS Fargate
    participant Aurora

    EB->>Lambda: Trigger (cron: daily at 6 AM)
    Lambda->>Aurora: SELECT scheduled_executions WHERE active = true
    Aurora->>Lambda: Return active schedules

    loop For each schedule
        Lambda->>Secrets: Get internal API secret
        Secrets->>Lambda: Return JWT signing key
        Lambda->>Lambda: Generate JWT token (short-lived)
        Lambda->>ECS: POST /api/internal/execute-tool (with JWT)
        ECS->>ECS: Validate JWT signature
        ECS->>Aurora: INSERT INTO tool_executions
        Aurora->>ECS: Execution created
        ECS->>ECS: Execute tool (same as manual execution)
        ECS->>Aurora: Save results
        Aurora->>ECS: Results saved
        ECS->>Lambda: Return execution summary
    end

    Lambda->>Aurora: INSERT INTO execution_results (for each schedule)
    Aurora->>Lambda: Saved
    Lambda->>EB: Complete (with metrics)
```

### Scheduled Execution Security
- JWT tokens generated per-request with 5-minute expiry
- Internal API endpoint not exposed to public internet
- Security group restricts Lambda → ECS to specific port
- All executions logged with scheduler context

## Error Handling & Recovery

### Network Error Recovery
```mermaid
graph LR
    REQ[Request] --> TRY{Attempt 1}
    TRY -->|Success| SUCCESS[Return result]
    TRY -->|Network error| RETRY1{Retry attempt 2}
    RETRY1 -->|Success| SUCCESS
    RETRY1 -->|Timeout| RETRY2{Retry attempt 3}
    RETRY2 -->|Success| SUCCESS
    RETRY2 -->|Failed| FALLBACK{Fallback available?}
    FALLBACK -->|Yes| ALT_MODEL[Try alternative model]
    FALLBACK -->|No| ERROR[Return error to user]
    ALT_MODEL -->|Success| SUCCESS
    ALT_MODEL -->|Failed| ERROR

    classDef success fill:#4caf50,stroke:#388e3c,stroke-width:2px
    classDef error fill:#f44336,stroke:#c62828,stroke-width:2px
    classDef retry fill:#ff9800,stroke:#e65100,stroke-width:2px

    class SUCCESS success
    class ERROR error
    class RETRY1,RETRY2,FALLBACK retry
```

### Exponential Backoff Configuration
```typescript
const retryConfig = {
  maxAttempts: 3,
  baseDelay: 1000,      // 1 second
  maxDelay: 10000,      // 10 seconds
  backoffMultiplier: 2, // 1s → 2s → 4s
  jitter: true,         // Add randomness to prevent thundering herd
}
```

## Rate Limiting & Quotas

### Per-User Limits
```
Nexus Chat:
├── Requests: 100 per minute
├── Tokens: 100,000 per hour
└── Concurrent streams: 3

Model Compare:
├── Comparisons: 20 per minute
└── Concurrent executions: 2

Assistant Architect:
├── Executions: 10 per minute
├── Total prompts: 50 per hour
└── Concurrent executions: 1

Document Processing:
├── Uploads: 10 per minute
├── Max size: 10 MB per file
└── Textract pages: 100 per day (cost control)
```

### Implementation
```typescript
// Redis-based rate limiting (future enhancement)
const rateLimiter = new RateLimiter({
  windowMs: 60 * 1000,  // 1 minute window
  max: 100,              // Max requests per window
  keyGenerator: (req) => req.session.user.id,
  handler: (req, res) => {
    res.status(429).json({
      error: "Too many requests",
      retryAfter: res.getHeader("Retry-After"),
    })
  },
})
```

---

**Last Updated**: November 2025
**Streaming Protocol**: HTTP/2 Server-Sent Events (SSE)
**AI Providers**: Bedrock, OpenAI, Google AI (parallel support)
**Database**: Aurora Serverless v2 with pgvector
**Background Processing**: Lambda + SQS for async tasks
