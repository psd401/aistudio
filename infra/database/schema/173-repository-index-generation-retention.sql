-- ============================================================================
-- 173: bounded retention for superseded repository index generations (#1527)
-- ============================================================================
--
-- The scheduled collector ranks superseded generations per repository by this
-- ordering, retains the newest three and a 24-hour safety window, then deletes
-- old chunks and childless generation rows in bounded batches.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_repository_index_generations_superseded_retention
  ON repository_index_generations (repository_id, created_at DESC, id DESC)
  WHERE status = 'superseded';

-- ROLLBACK SQL (for manual rollback if needed)
-- DROP INDEX IF EXISTS idx_repository_index_generations_superseded_retention;
