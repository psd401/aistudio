-- ============================================================================
-- 172: Atrium artifact data records (#1516, Epic #1515)
-- ============================================================================
--
-- This is an append-only store. It intentionally has no updated_at column or
-- update trigger, and it has no retention/TTL column. Records are retained
-- until their parent content object is deleted. User attribution is cleared,
-- rather than blocking deletion or removing the record, if a user is deleted.
--
-- The action layer also validates namespace and payload size. The namespace
-- CHECK remains the database-level backstop for writes outside that layer.
-- ============================================================================

CREATE TABLE IF NOT EXISTS content_data_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID NOT NULL
    REFERENCES content_objects(id) ON DELETE CASCADE,
  namespace VARCHAR(64) NOT NULL,
  user_id INTEGER
    REFERENCES users(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_content_data_records_namespace
    CHECK (namespace ~ '^[a-z0-9_-]{1,64}$')
);

CREATE INDEX IF NOT EXISTS idx_content_data_records_lookup
  ON content_data_records (content_id, namespace, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_content_data_records_user
  ON content_data_records (user_id, content_id, namespace);

-- ROLLBACK SQL (for manual rollback if needed)
-- DROP TABLE IF EXISTS content_data_records;
