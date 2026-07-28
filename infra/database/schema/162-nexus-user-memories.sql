-- Migration 162: Persistent Nexus user memory (Epic #1406 / Issue #1407)
--
-- Stores user-owned, write-time-screened memory for Nexus chat. The system
-- prompt bypasses the normal message safety pipeline, so application code MUST
-- pass every write through lib/nexus/memory/memory-service.ts before storage.
--
-- Additive and idempotent. No transaction control or dollar-quoted blocks are
-- used because the migration runner owns the transaction and statement split.

CREATE TABLE IF NOT EXISTS nexus_user_memories (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content                 text NOT NULL CHECK (btrim(content) <> ''),
  category                text NOT NULL DEFAULT 'context'
                            CHECK (category IN ('profile', 'preference', 'context')),
  source                  text NOT NULL
                            CHECK (
                              source IN (
                                'tool',
                                'manual',
                                'auto',
                                'import:chatgpt',
                                'import:claude',
                                'import:gemini'
                              )
                            ),
  source_conversation_id  uuid REFERENCES nexus_conversations(id) ON DELETE SET NULL,
  embedding               vector(512),
  deleted_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nexus_user_memories_embedding_hnsw
  ON nexus_user_memories USING hnsw (embedding vector_cosine_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_nexus_user_memories_user_live
  ON nexus_user_memories (user_id)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS update_nexus_user_memories_updated_at
  ON nexus_user_memories;
CREATE TRIGGER update_nexus_user_memories_updated_at
  BEFORE UPDATE ON nexus_user_memories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO settings (key, value, description, category, is_secret)
VALUES
  (
    'NEXUS_MEMORY_ENABLED',
    'true',
    'Global kill switch for Nexus user-memory retrieval and writes.',
    'nexus-memory',
    false
  ),
  (
    'MEMORY_EMBEDDING_MODEL_ID',
    'amazon.titan-embed-text-v2:0',
    'Bedrock model id used directly for Nexus user-memory embeddings. The memory vector column is fixed at 512 dimensions.',
    'nexus-memory',
    false
  ),
  (
    'MEMORY_EMBEDDING_DIMENSIONS',
    '512',
    'Fixed Nexus user-memory embedding dimensions. Changing this requires a re-embed backfill and column migration.',
    'nexus-memory',
    false
  ),
  (
    'MEMORY_RETRIEVAL_THRESHOLD',
    '0.3',
    'Minimum cosine similarity for preference and context memory retrieval.',
    'nexus-memory',
    false
  ),
  (
    'MEMORY_RETRIEVAL_TOP_K',
    '6',
    'Maximum preference and context memories retrieved for one Nexus turn.',
    'nexus-memory',
    false
  )
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- ROLLBACK SQL (for manual rollback if needed)
-- ============================================
-- DROP TABLE IF EXISTS nexus_user_memories;
-- DELETE FROM settings WHERE key IN (
--   'NEXUS_MEMORY_ENABLED',
--   'MEMORY_EMBEDDING_MODEL_ID',
--   'MEMORY_EMBEDDING_DIMENSIONS',
--   'MEMORY_RETRIEVAL_THRESHOLD',
--   'MEMORY_RETRIEVAL_TOP_K'
-- );
