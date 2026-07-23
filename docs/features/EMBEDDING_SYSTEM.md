# Embedding System Documentation

## Overview

The AI Studio platform includes a comprehensive embedding generation system for semantic search and similarity matching. This system processes text chunks from documents and generates vector embeddings using configurable AI models.

## Architecture

### Components

1. **File Processor Lambda**
   - Extracts text from uploaded documents
   - Chunks text into manageable pieces
   - Queues chunks for embedding generation
   - Updates processing status

2. **Embedding Generator Lambda**
   - Receives chunks from SQS queue
   - Generates embeddings using the configured provider
   - Defaults to Amazon Bedrock through the Lambda workload role (no static AWS keys)
   - Stores embeddings in PostgreSQL
   - Updates item status to "embedded"

3. **Database Schema**
   - `repository_item_chunks.embedding`: PostgreSQL `vector(1536)`
   - `repository_index_generations.embedding_model`: provider-qualified model descriptor
   - `repository_index_generations.embedding_dimensions`: vector-space size
   - `settings` table: Stores embedding configuration
   - Supports vectors of varying dimensions (typically 1536 for OpenAI)

### Processing Flow

```
File Upload → S3 → File Processor → Text Chunks → SQS Queue → Embedding Generator → PostgreSQL
```

## Configuration

Embedding settings are stored in the database and can be configured via the admin settings UI:

```sql
-- Example configuration
INSERT INTO settings (category, key, value) VALUES
('embeddings', 'EMBEDDING_MODEL_PROVIDER', 'amazon-bedrock'),
('embeddings', 'EMBEDDING_MODEL_ID', 'amazon.titan-embed-text-v1'),
('embeddings', 'EMBEDDING_DIMENSIONS', '1536'),
('embeddings', 'EMBEDDING_BATCH_SIZE', '100');
```

### Supported Providers

- **OpenAI**: text-embedding-ada-002, text-embedding-3-small, text-embedding-3-large
- **AWS Bedrock**: `amazon.titan-embed-text-v1` is the compatibility default;
  Titan V2 is supported by the worker when the database vector dimension is
  migrated to 1024, 512, or 256.
- **Azure OpenAI**: Configured deployment names

## Implementation Details

### Embedding Generation

The system uses the AI SDK for unified provider access:

```typescript
// In ai-helpers.ts
export async function generateEmbedding(
  text: string,
  config?: Partial<EmbeddingConfig>
): Promise<number[]> {
  const embeddingConfig = config ? { ...await getEmbeddingConfig(), ...config } : await getEmbeddingConfig()
  const modelConfig: ModelConfig = {
    provider: embeddingConfig.provider,
    modelId: embeddingConfig.modelId
  }
  const model = await getModelClient(modelConfig)
  const result = await embed({ model, value: text })
  return Array.from(result.embedding)
}
```

### PostgreSQL Storage

Embeddings are stored with pgvector for indexed cosine similarity:

```sql
-- Creating the column
ALTER TABLE repository_item_chunks
ADD COLUMN embedding vector(1536);

-- Storing embeddings (with proper casting)
UPDATE repository_item_chunks 
SET embedding = '[0.123, 0.456, ...]'::vector
WHERE id = :id;
```

### Status Tracking

Repository items progress through these statuses:
- `pending`: Initial upload
- `processing`: Text extraction and chunking
- `processing_embeddings`: Generating embeddings
- `embedded`: Successfully embedded
- `embedding_failed`: Error during embedding generation

## Authentication and model changes

In AWS, Bedrock uses the Lambda execution role and `AWS_REGION`. Stored
`BEDROCK_ACCESS_KEY_ID` / `BEDROCK_SECRET_ACCESS_KEY` values are ignored by the
Lambda and remain only a local-development compatibility option.

Every canonical index generation records a provider-qualified descriptor such
as `amazon-bedrock:amazon.titan-embed-text-v1`. When a publication changes the
model or dimensions, copied chunks have their prior vectors cleared and the
whole new generation is queued for re-embedding. Semantic queries use the
active generation's descriptor, so different embedding spaces are never mixed.
Hybrid search falls back to lexical results if its embedding provider is
temporarily unavailable.

## Error Handling

- Failed embeddings are sent to Dead Letter Queue after 3 attempts
- Errors are logged to CloudWatch
- Item status updated to "embedding_failed" with error message

## Performance Considerations

- Batch processing: Up to 100 texts per API call (configurable)
- Lambda memory: 1GB allocated for embedding generation
- Queue visibility timeout: 10 minutes
- Automatic retry with exponential backoff

## Future Enhancements

- Titan Text Embeddings V2 dimensional migration and controlled backfill
- Hybrid search combining keywords and semantics
- Embedding model comparison and A/B testing
- Incremental embedding updates
- Support for multimodal embeddings
