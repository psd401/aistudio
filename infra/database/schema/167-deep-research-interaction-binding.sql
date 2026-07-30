-- ============================================================================
-- 167 — Bind Gemini interactions to Deep Research budget reservations (#1465)
-- ============================================================================

-- A failed first attempt may have applied an idempotent statement before the
-- migration runner recorded the failure. Mark that record retryable before
-- re-running the additive operations below.
UPDATE migration_log SET status = 'completed'
WHERE description = '167-deep-research-interaction-binding.sql'
  AND status = 'failed';

ALTER TABLE deep_research_reservations
  ADD COLUMN IF NOT EXISTS interaction_id TEXT;

CREATE INDEX IF NOT EXISTS idx_deep_research_interaction_id
  ON deep_research_reservations(interaction_id)
  WHERE interaction_id IS NOT NULL;

-- Manual rollback (only after the broker stops using interaction ownership):
-- DROP INDEX IF EXISTS idx_deep_research_interaction_id;
-- ALTER TABLE deep_research_reservations DROP COLUMN IF EXISTS interaction_id;
