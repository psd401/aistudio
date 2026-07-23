-- Migration 121: Retrieval v2, hierarchical segments, and visual search
--
-- Retrieval resolves one immutable index generation per repository and never
-- mixes vector spaces. These additive fields carry the context, hierarchy,
-- segment ACL, lexical index, and optional multimodal embedding needed by the
-- shared retrieval service.

ALTER TABLE repository_item_chunks
  ADD COLUMN IF NOT EXISTS context_prefix text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS segment_level varchar(16) NOT NULL DEFAULT 'chunk',
  ADD COLUMN IF NOT EXISTS parent_chunk_index integer,
  ADD COLUMN IF NOT EXISTS access_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS visual_embedding vector(1536);

ALTER TABLE repository_item_chunks
  DROP CONSTRAINT IF EXISTS chk_repository_chunks_segment_level,
  ADD CONSTRAINT chk_repository_chunks_segment_level
    CHECK (segment_level IN ('document', 'section', 'chunk')),
  DROP CONSTRAINT IF EXISTS chk_repository_chunks_parent_index,
  ADD CONSTRAINT chk_repository_chunks_parent_index
    CHECK (parent_chunk_index IS NULL OR parent_chunk_index >= 0),
  DROP CONSTRAINT IF EXISTS chk_repository_chunks_access_scope,
  ADD CONSTRAINT chk_repository_chunks_access_scope
    CHECK (jsonb_typeof(access_scope) = 'object');

ALTER TABLE repository_item_chunks
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', trim(context_prefix || ' ' || content))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_repository_chunks_search_vector
  ON repository_item_chunks USING gin (search_vector);
CREATE INDEX IF NOT EXISTS idx_repository_chunks_generation_modality
  ON repository_item_chunks (index_generation_id, modality, segment_level, item_id);
CREATE INDEX IF NOT EXISTS idx_repository_chunks_visual_embedding_hnsw
  ON repository_item_chunks USING hnsw (visual_embedding vector_cosine_ops)
  WHERE visual_embedding IS NOT NULL;

ALTER TABLE repository_index_generations
  ADD COLUMN IF NOT EXISTS segmentation_version varchar(128) NOT NULL DEFAULT 'legacy-v1',
  ADD COLUMN IF NOT EXISTS visual_embedding_model varchar(255),
  ADD COLUMN IF NOT EXISTS visual_embedding_dimensions integer;

ALTER TABLE repository_index_generations
  DROP CONSTRAINT IF EXISTS chk_repository_index_generation_visual_dimensions,
  ADD CONSTRAINT chk_repository_index_generation_visual_dimensions
    CHECK (
      (visual_embedding_model IS NULL AND visual_embedding_dimensions IS NULL)
      OR (visual_embedding_model IS NOT NULL AND visual_embedding_dimensions = 1536)
    );

INSERT INTO settings (key, value, description, category, is_secret)
VALUES
  ('CONTENT_RETRIEVAL_RERANK_ENABLED', 'true', 'Rerank fused retrieval candidates with Amazon Bedrock. Retrieval fails open to deterministic rank fusion.', 'Content Platform', false),
  ('CONTENT_RETRIEVAL_RERANK_MODEL_ID', 'cohere.rerank-v3-5:0', 'Amazon Bedrock reranking model for repository retrieval.', 'Content Platform', false),
  ('CONTENT_RETRIEVAL_CANDIDATE_LIMIT', '40', 'Maximum dense and lexical candidates considered before reranking.', 'Content Platform', false),
  ('CONTENT_RETRIEVAL_NEIGHBOR_COUNT', '1', 'Number of adjacent segments expanded on either side of each selected result.', 'Content Platform', false),
  ('CONTENT_RETRIEVAL_CONTEXT_TOKENS', '4000', 'Maximum tokenizer-counted context returned by one retrieval request.', 'Content Platform', false),
  ('CONTENT_RETRIEVAL_RRF_K', '60', 'Reciprocal-rank-fusion smoothing constant.', 'Content Platform', false),
  ('CONTENT_RETRIEVAL_MAX_PER_SOURCE', '3', 'Maximum selected segments from one immutable item version before source diversification.', 'Content Platform', false),
  ('CONTENT_VISUAL_EMBEDDING_MODEL_ID', 'cohere.embed-v4:0', 'Amazon Bedrock Cohere Embed v4 model used for multimodal repository segments.', 'Content Platform', false),
  ('CONTENT_VISUAL_EMBEDDING_DIMENSIONS', '1536', 'Visual embedding dimensions; fixed to the repository visual vector schema.', 'Content Platform', false)
ON CONFLICT (key) DO NOTHING;
