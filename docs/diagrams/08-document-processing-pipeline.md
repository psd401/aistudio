# Document Processing Pipeline

Complete asynchronous document processing flow from upload → S3 → Lambda → Textract → Embedding → PostgreSQL with pgvector.

## Overview

The document processing pipeline handles:
- Multi-format document uploads (PDF, DOCX, TXT, URLs)
- Async processing via Lambda + SQS queuing
- OCR via AWS Textract for scanned documents
- Text chunking for optimal embedding
- Vector embedding generation via Amazon Bedrock
- Storage in PostgreSQL with pgvector for similarity search

## Complete Processing Flow

```mermaid
sequenceDiagram
    participant User
    participant Browser
    participant API as Next.js API
    participant S3
    participant SQS as SQS Queue
    participant FileLambda as file-processor Lambda
    participant TextractLambda as textract-processor Lambda
    participant EmbedLambda as embedding-generator Lambda
    participant Textract as AWS Textract
    participant Bedrock as Amazon Bedrock
    participant Aurora as Aurora PostgreSQL

    User->>Browser: Upload document (PDF/DOCX/TXT)
    Browser->>API: Request presigned S3 URL
    API->>S3: Generate presigned POST URL
    S3->>API: Return presigned URL + fields
    API->>Browser: Return upload credentials

    Browser->>S3: Direct upload to S3 (multipart if > 5MB)
    S3->>Browser: Upload complete

    Note over S3,SQS: S3 Event Notification triggers processing

    S3->>SQS: Object created event
    SQS->>FileLambda: Poll message

    FileLambda->>FileLambda: Parse S3 event
    FileLambda->>S3: GetObject (download file)
    S3->>FileLambda: Return file buffer

    FileLambda->>Aurora: INSERT INTO repository_items<br/>(status: 'processing')
    Aurora->>FileLambda: Item created (id: 123)

    alt File type: PDF/Image (scanned)
        FileLambda->>FileLambda: Detect if text-based or scanned
        alt Scanned PDF/Image
            FileLambda->>Aurora: INSERT INTO textract_jobs
            Aurora->>FileLambda: Job recorded
            FileLambda->>Textract: StartDocumentTextDetection
            Textract->>FileLambda: JobId returned

            Note over Textract: Async OCR processing (30s - 2min)

            Textract->>SQS: Completion notification (if SNS configured)
            SQS->>TextractLambda: Poll completion event
            TextractLambda->>Textract: GetDocumentTextDetection
            Textract->>TextractLambda: Extracted text + confidence scores
            TextractLambda->>Aurora: UPDATE repository_items<br/>SET extracted_text = ...
        else Text-based PDF
            FileLambda->>FileLambda: Extract text with pdf-parse
            FileLambda->>Aurora: UPDATE repository_items<br/>SET extracted_text = ...
        end
    else File type: DOCX
        FileLambda->>FileLambda: Extract text with mammoth.js
        FileLambda->>Aurora: UPDATE repository_items<br/>SET extracted_text = ...
    else File type: TXT
        FileLambda->>FileLambda: Read buffer as UTF-8
        FileLambda->>Aurora: UPDATE repository_items<br/>SET extracted_text = ...
    end

    Note over FileLambda: Text extraction complete, begin chunking

    FileLambda->>FileLambda: Chunk text (1000 tokens/chunk)
    FileLambda->>FileLambda: Sanitize text (remove null bytes, invalid UTF-8)

    loop For each chunk
        FileLambda->>Aurora: INSERT INTO repository_item_chunks<br/>(content, chunk_index, metadata)
        Aurora->>FileLambda: Chunk created (id: 456)
    end

    Note over FileLambda,EmbedLambda: Trigger embedding generation

    FileLambda->>SQS: Send message to embedding queue
    SQS->>EmbedLambda: Poll message

    loop For each chunk batch (max 25 chunks)
        EmbedLambda->>Aurora: SELECT chunks WHERE embedding IS NULL
        Aurora->>EmbedLambda: Return chunks

        EmbedLambda->>Bedrock: InvokeModel (amazon.titan-embed-text-v2)
        Bedrock->>EmbedLambda: Return 1536-dim vectors

        EmbedLambda->>Aurora: UPDATE repository_item_chunks<br/>SET embedding = vector
        Aurora->>EmbedLambda: Embeddings saved
    end

    EmbedLambda->>Aurora: UPDATE repository_items<br/>SET processing_status = 'completed'
    Aurora->>EmbedLambda: Status updated

    Aurora->>Browser: Notify via polling/websocket
    Browser->>User: Document ready for search
```

## File Upload Flow (S3 Presigned URL)

```mermaid
graph TB
    START[User clicks upload] --> VALIDATE{Validate file}
    VALIDATE -->|Invalid type| ERROR1[Show error: Unsupported file type]
    VALIDATE -->|Too large| ERROR2[Show error: File too large]
    VALIDATE -->|Valid| REQUEST_URL[POST /api/documents/presigned-url]

    REQUEST_URL --> AUTH{Authenticated?}
    AUTH -->|No| ERROR3[401 Unauthorized]
    AUTH -->|Yes| GEN_KEY[Generate unique S3 key<br/>user_id/timestamp/filename]

    GEN_KEY --> MULTIPART{File > 5MB?}
    MULTIPART -->|No| SIMPLE_PRESIGN[Generate simple presigned POST]
    MULTIPART -->|Yes| MULTI_PRESIGN[Generate multipart upload]

    SIMPLE_PRESIGN --> RETURN_CREDS[Return presigned URL + fields]
    MULTI_PRESIGN --> RETURN_CREDS

    RETURN_CREDS --> BROWSER_UPLOAD[Browser uploads directly to S3]
    BROWSER_UPLOAD --> S3_CONFIRM[S3 returns success]
    S3_CONFIRM --> CONFIRM_API[POST /api/documents/confirm-upload]
    CONFIRM_API --> INSERT_DB[INSERT INTO repository_items<br/>status='pending']
    INSERT_DB --> WAIT_PROCESS[Wait for Lambda processing]

    ERROR1 --> END[End]
    ERROR2 --> END
    ERROR3 --> END
    WAIT_PROCESS --> END

    classDef error fill:#ffcccc,stroke:#c62828,stroke-width:2px
    classDef process fill:#fff9c4,stroke:#f57f17,stroke-width:2px
    classDef success fill:#c8e6c9,stroke:#388e3c,stroke-width:2px

    class ERROR1,ERROR2,ERROR3 error
    class GEN_KEY,MULTIPART,SIMPLE_PRESIGN,MULTI_PRESIGN process
    class S3_CONFIRM,INSERT_DB success
```

## Text Extraction Methods

### PDF Processing

```typescript
// Text-based PDF (fast path)
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const result = await pdfParse(buffer);
const text = result.text;
const metadata = {
  pageCount: result.numpages,
  info: result.info
};

// Scanned PDF (OCR path via Textract)
const textractClient = new TextractClient({});
const command = new StartDocumentTextDetectionCommand({
  DocumentLocation: {
    S3Object: {
      Bucket: bucket,
      Name: key
    }
  },
  NotificationChannel: {
    SNSTopicArn: snsTopicArn,
    RoleArn: textractRoleArn
  }
});

const { JobId } = await textractClient.send(command);

// Later, retrieve results
const getCommand = new GetDocumentTextDetectionCommand({ JobId });
const { Blocks } = await textractClient.send(getCommand);

const extractedText = Blocks
  .filter(block => block.BlockType === 'LINE')
  .map(block => block.Text)
  .join('\n');
```

### DOCX Processing

```typescript
import mammoth from 'mammoth';

const result = await mammoth.extractRawText({ buffer });
const text = result.value;
const metadata = {
  messages: result.messages  // Warnings about unsupported features
};
```

### TXT Processing

```typescript
const text = buffer.toString('utf-8');

// Sanitize to remove null bytes and invalid UTF-8
const sanitized = sanitizeTextWithMetrics(text);
```

## Text Chunking Strategy

```mermaid
graph TB
    TEXT[Extracted Text] --> SANITIZE[Sanitize text<br/>Remove null bytes, invalid UTF-8]
    SANITIZE --> SPLIT_PARA[Split by paragraph<br/>(double newline)]

    SPLIT_PARA --> INIT_CHUNK[Initialize chunk buffer]

    LOOP_START[For each paragraph] --> CHECK_SIZE{Chunk + para<br/>< maxSize?}
    CHECK_SIZE -->|Yes| ADD_PARA[Add paragraph to chunk]
    CHECK_SIZE -->|No| SAVE_CHUNK[Save current chunk]

    ADD_PARA --> NEXT_PARA[Next paragraph]
    SAVE_CHUNK --> START_NEW[Start new chunk with paragraph]
    START_NEW --> NEXT_PARA

    NEXT_PARA --> MORE{More paragraphs?}
    MORE -->|Yes| LOOP_START
    MORE -->|No| FINAL_CHUNK[Save final chunk]

    FINAL_CHUNK --> CHUNKS[Array of chunks]

    classDef process fill:#fff9c4,stroke:#f57f17,stroke-width:2px
    classDef output fill:#c8e6c9,stroke:#388e3c,stroke-width:2px

    class SANITIZE,SPLIT_PARA,ADD_PARA,SAVE_CHUNK,START_NEW process
    class CHUNKS output
```

### Chunking Algorithm

```typescript
export function chunkText(text: string, maxChunkSize: number = 1000): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length <= maxChunkSize) {
      currentChunk += paragraph + '\n\n';
    } else {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = paragraph + '\n\n';
    }
  }

  if (currentChunk) chunks.push(currentChunk.trim());
  return chunks;
}
```

## Embedding Generation

```mermaid
sequenceDiagram
    participant Lambda as embedding-generator
    participant Aurora
    participant Bedrock as Amazon Bedrock

    Lambda->>Aurora: SELECT chunks WHERE embedding IS NULL<br/>LIMIT 25
    Aurora->>Lambda: Return unbatched chunks

    loop For each chunk
        Lambda->>Bedrock: InvokeModel (titan-embed-text-v2)<br/>Input: chunk.content
        Bedrock->>Lambda: Return 1536-dim vector
        Lambda->>Lambda: Store vector in batch
    end

    Lambda->>Aurora: BEGIN TRANSACTION
    loop For each vector
        Lambda->>Aurora: UPDATE repository_item_chunks<br/>SET embedding = $vector<br/>WHERE id = $id
    end
    Lambda->>Aurora: COMMIT TRANSACTION

    Lambda->>Aurora: Check for more chunks
    Aurora->>Lambda: Return count
    alt More chunks exist
        Lambda->>Lambda: Recursively process next batch
    else All chunks complete
        Lambda->>Aurora: UPDATE repository_items<br/>SET processing_status = 'completed'
    end
```

### Bedrock Embedding Request

```typescript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({});

const requestBody = {
  inputText: chunkContent,
  dimensions: 1536,
  normalize: true
};

const command = new InvokeModelCommand({
  modelId: 'amazon.titan-embed-text-v2:0',
  contentType: 'application/json',
  accept: 'application/json',
  body: JSON.stringify(requestBody)
});

const response = await client.send(command);
const result = JSON.parse(new TextDecoder().decode(response.body));
const embedding = result.embedding;  // Float32Array of 1536 dimensions
```

## Vector Search (pgvector)

```sql
-- Create vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add vector column to chunks table
ALTER TABLE repository_item_chunks
ADD COLUMN embedding vector(1536);

-- Create HNSW index for fast similarity search
CREATE INDEX idx_repository_item_chunks_embedding
ON repository_item_chunks
USING hnsw (embedding vector_cosine_ops);

-- Similarity search query
SELECT
    c.id,
    c.content,
    r.name AS repository_name,
    1 - (c.embedding <=> $query_vector) AS similarity
FROM repository_item_chunks c
JOIN repository_items i ON c.item_id = i.id
JOIN knowledge_repositories r ON i.repository_id = r.id
WHERE i.repository_id = ANY($repository_ids)
  AND (1 - (c.embedding <=> $query_vector)) > $threshold
ORDER BY c.embedding <=> $query_vector
LIMIT $top_k;
```

## Processing Times & Costs

### Processing Time Breakdown

| File Type | Size | Textract | Extraction | Chunking | Embedding | Total Time |
|-----------|------|----------|------------|----------|-----------|------------|
| **TXT** | 100 KB | 0s | 0.1s | 0.5s | 2s | **2.6s** |
| **DOCX** | 500 KB | 0s | 1.2s | 1.5s | 5s | **7.7s** |
| **PDF (text)** | 2 MB | 0s | 3s | 2s | 10s | **15s** |
| **PDF (scanned)** | 5 MB (50 pages) | 45s | 0s | 3s | 15s | **63s** |
| **Large PDF** | 50 MB (500 pages) | 180s | 15s | 8s | 60s | **263s** |

### Cost per Document

```
Text extraction:
├── PDF text-based: $0 (pdf-parse library)
├── DOCX: $0 (mammoth.js library)
├── TXT: $0 (native Node.js)
└── PDF scanned (Textract): $1.50 per 1,000 pages
    Example: 100-page scanned PDF = $0.15

Embedding generation (Bedrock Titan Embeddings):
├── Cost: $0.0001 per 1,000 tokens
├── Example: 10,000-word document (~13,000 tokens) = $0.0013
└── Large document: 100,000 words (~130,000 tokens) = $0.013

Storage (PostgreSQL with pgvector):
├── Vector storage: ~6 KB per 1536-dim embedding
├── 1,000 chunks = ~6 MB storage
└── Aurora storage: $0.10/GB/month → $0.0006/month for 1,000 chunks

Total cost per document:
├── Small text document (TXT/DOCX): $0.001 - $0.002
├── Medium PDF (text): $0.005 - $0.01
└── Large scanned PDF (100 pages): $0.15 - $0.17
```

## Lambda Configuration

### file-processor

```typescript
{
  runtime: 'nodejs20.x',
  memorySize: 1024,  // Based on PowerTuning results
  timeout: 300,      // 5 minutes for large files
  environment: {
    BUCKET_NAME: documentBucket.bucketName,
    TEXTRACT_SNS_TOPIC_ARN: textractTopic.topicArn,
    EMBEDDING_QUEUE_URL: embeddingQueue.queueUrl
  },
  reservedConcurrentExecutions: 10  // Limit parallel processing
}
```

### textract-processor

```typescript
{
  runtime: 'nodejs20.x',
  memorySize: 512,   // Lightweight
  timeout: 600,      // 10 minutes for large OCR jobs
  environment: {
    TEXTRACT_ROLE_ARN: textractRole.roleArn
  }
}
```

### embedding-generator

```typescript
{
  runtime: 'nodejs20.x',
  memorySize: 1024,
  timeout: 300,
  environment: {
    BEDROCK_MODEL_ID: 'amazon.titan-embed-text-v2:0',
    BATCH_SIZE: '25'
  },
  reservedConcurrentExecutions: 5  // Bedrock throttling protection
}
```

## Error Handling & Retry Logic

```mermaid
graph TB
    PROCESS[Process document] --> SUCCESS{Success?}
    SUCCESS -->|Yes| COMPLETE[Mark completed]
    SUCCESS -->|No| ERROR_TYPE{Error type}

    ERROR_TYPE -->|Transient| RETRY{Retry count<br/>< 3?}
    ERROR_TYPE -->|Fatal| MARK_FAILED[Mark processing_status = 'failed'<br/>Store error_message]

    RETRY -->|Yes| BACKOFF[Exponential backoff<br/>1s → 2s → 4s]
    BACKOFF --> PROCESS
    RETRY -->|No| MARK_FAILED

    MARK_FAILED --> NOTIFY_USER[Send notification<br/>to user]

    COMPLETE --> INDEX[Create vector index]
    INDEX --> READY[Document ready for search]

    classDef success fill:#c8e6c9,stroke:#388e3c,stroke-width:2px
    classDef error fill:#ffcccc,stroke:#c62828,stroke-width:2px
    classDef retry fill:#fff9c4,stroke:#f57f17,stroke-width:2px

    class COMPLETE,INDEX,READY success
    class MARK_FAILED,NOTIFY_USER error
    class RETRY,BACKOFF retry
```

### SQS Dead Letter Queue

```typescript
const processingQueue = new Queue(this, 'DocumentProcessingQueue', {
  visibilityTimeout: Duration.minutes(6),
  retentionPeriod: Duration.days(14),
  receiveMessageWaitTime: Duration.seconds(20),
  deadLetterQueue: {
    queue: deadLetterQueue,
    maxReceiveCount: 3  // After 3 failures, move to DLQ
  }
});
```

## Database Schema

```sql
-- repository_items: Document metadata
CREATE TABLE repository_items (
    id SERIAL PRIMARY KEY,
    repository_id INT NOT NULL,
    type VARCHAR(50),                    -- 'document', 'url', 'text'
    name VARCHAR(255),
    source TEXT,                         -- S3 key or URL
    processing_status VARCHAR(20),       -- pending, processing, completed, failed
    processing_error TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (repository_id) REFERENCES knowledge_repositories(id) ON DELETE CASCADE
);

-- repository_item_chunks: Chunked content with embeddings
CREATE TABLE repository_item_chunks (
    id SERIAL PRIMARY KEY,
    item_id INT NOT NULL,
    content TEXT NOT NULL,
    chunk_index INT NOT NULL,
    metadata JSONB,
    embedding vector(1536),              -- pgvector type
    tokens INT,
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (item_id) REFERENCES repository_items(id) ON DELETE CASCADE
);

-- textract_jobs: Track OCR jobs
CREATE TABLE textract_jobs (
    job_id VARCHAR(255) PRIMARY KEY,
    item_id INT NOT NULL,
    file_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (item_id) REFERENCES repository_items(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX idx_repository_items_status ON repository_items(processing_status);
CREATE INDEX idx_repository_items_repository_id ON repository_items(repository_id);
CREATE INDEX idx_repository_item_chunks_item_id ON repository_item_chunks(item_id);
CREATE INDEX idx_repository_item_chunks_embedding ON repository_item_chunks
  USING hnsw (embedding vector_cosine_ops);
```

## Monitoring & Observability

### CloudWatch Metrics

```typescript
// Custom metrics published by Lambda
const metrics = {
  DocumentsProcessed: new MetricFilter({
    metricName: 'DocumentsProcessed',
    metricNamespace: 'AIStudio/DocumentProcessing',
    filterPattern: FilterPattern.literal('[status = completed]')
  }),

  ProcessingDuration: new Metric({
    metricName: 'ProcessingDuration',
    namespace: 'AIStudio/DocumentProcessing',
    statistic: 'Average',
    unit: 'Milliseconds'
  }),

  TextractPages: new Metric({
    metricName: 'TextractPagesProcessed',
    namespace: 'AIStudio/DocumentProcessing',
    statistic: 'Sum'
  }),

  EmbeddingTokens: new Metric({
    metricName: 'EmbeddingTokensGenerated',
    namespace: 'AIStudio/DocumentProcessing',
    statistic: 'Sum'
  })
};
```

### CloudWatch Alarms

- **High error rate**: > 10% of documents fail processing
- **DLQ depth**: > 5 messages in dead letter queue
- **Processing latency**: > 5 minutes for standard documents
- **Textract quota**: Approaching 100 pages/day limit (cost control)

---

**Last Updated**: November 2025
**Supported Formats**: PDF, DOCX, TXT (PPT planned)
**Max File Size**: 10 MB (configurable up to 100 MB)
**Vector Dimensions**: 1536 (Titan Embeddings v2)
**Database**: PostgreSQL 15 with pgvector extension
