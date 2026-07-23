-- Migration 120: Bedrock-first repository embeddings
--
-- The legacy repository worker defaulted to an OpenAI project/model pairing
-- that is not guaranteed to be enabled. Keep the existing vector(1536) column
-- compatible while moving the default to IAM-authenticated Amazon Bedrock.

INSERT INTO settings (key, value, description, category, is_secret)
VALUES
  ('EMBEDDING_MODEL_PROVIDER', 'amazon-bedrock', 'Provider used for repository embeddings. Amazon Bedrock uses the workload IAM role in AWS.', 'embeddings', false),
  ('EMBEDDING_MODEL_ID', 'amazon.titan-embed-text-v1', 'Embedding model used for repository indexing and semantic queries.', 'embeddings', false),
  ('EMBEDDING_DIMENSIONS', '1536', 'Vector dimensions. Must match both the selected model and repository_item_chunks.embedding.', 'embeddings', false),
  ('EMBEDDING_MAX_TOKENS', '8192', 'Maximum embedding input tokens before content must be segmented.', 'embeddings', false),
  ('EMBEDDING_BATCH_SIZE', '100', 'Maximum texts grouped into one provider batch when batching is supported.', 'embeddings', false)
ON CONFLICT (key) DO NOTHING;

-- Label pre-existing generations before changing the global default. Empty
-- failed generations can safely retry with Bedrock; generations containing
-- vectors retain their legacy OpenAI query space until the next publication
-- rebuilds that repository under the new descriptor.
UPDATE repository_index_generations generation
   SET embedding_model = CASE
         WHEN EXISTS (
           SELECT 1
             FROM repository_item_chunks chunk
            WHERE chunk.index_generation_id = generation.id
              AND chunk.embedding IS NOT NULL
         ) THEN 'openai:text-embedding-3-small'
         ELSE 'amazon-bedrock:amazon.titan-embed-text-v1'
       END,
       embedding_dimensions = 1536
 WHERE embedding_model IS NULL;

-- Repair only the broken legacy OpenAI default. Deliberately preserve any
-- administrator-selected OpenAI/Azure/custom model configuration.
UPDATE settings
   SET value = 'amazon-bedrock',
       category = 'embeddings',
       description = 'Provider used for repository embeddings. Amazon Bedrock uses the workload IAM role in AWS.',
       updated_at = now()
 WHERE key = 'EMBEDDING_MODEL_PROVIDER'
   AND value = 'openai'
   AND EXISTS (
     SELECT 1
       FROM settings model_setting
      WHERE model_setting.key = 'EMBEDDING_MODEL_ID'
        AND model_setting.value = 'text-embedding-3-small'
   );

UPDATE settings
   SET value = 'amazon.titan-embed-text-v1',
       category = 'embeddings',
       description = 'Embedding model used for repository indexing and semantic queries.',
       updated_at = now()
 WHERE key = 'EMBEDDING_MODEL_ID'
   AND value = 'text-embedding-3-small'
   AND EXISTS (
     SELECT 1
       FROM settings provider_setting
      WHERE provider_setting.key = 'EMBEDDING_MODEL_PROVIDER'
        AND provider_setting.value = 'amazon-bedrock'
   );

-- If a repository's active generation never received even one legacy vector,
-- replay exactly one already-succeeded content job for that repository. The
-- publication path recognizes the completed generation idempotently and its
-- embedding dispatcher queues every still-null chunk. This recovers messages
-- that reached the embedding DLQ before the Bedrock default was deployed,
-- without rebuilding repositories that contain a valid legacy vector space.
UPDATE repository_processing_jobs job
   SET status = 'pending',
       attempt = 0,
       available_at = now(),
       lease_owner = NULL,
       lease_expires_at = NULL,
       last_error_code = NULL,
       last_error_message = NULL,
       finished_at = NULL,
       updated_at = now()
 WHERE job.id IN (
   SELECT DISTINCT ON (repository.id) candidate.id
     FROM knowledge_repositories repository
     JOIN repository_items item
       ON item.repository_id = repository.id
      AND item.current_version_id IS NOT NULL
     JOIN repository_processing_jobs candidate
       ON candidate.item_version_id = item.current_version_id
      AND candidate.status = 'succeeded'
    WHERE repository.active_index_generation_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM repository_item_chunks missing
         WHERE missing.index_generation_id = repository.active_index_generation_id
           AND missing.embedding IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
          FROM repository_item_chunks embedded
         WHERE embedded.index_generation_id = repository.active_index_generation_id
           AND embedded.embedding IS NOT NULL
      )
    ORDER BY repository.id, candidate.created_at DESC
 );
