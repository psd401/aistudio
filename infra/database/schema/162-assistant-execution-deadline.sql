-- ============================================================================
-- 162 — Durable Assistant Architect execution deadlines
--
-- Import replacement must distinguish a live execution from an abandoned row
-- without recomputing the run's deadline from mutable assistant settings. New
-- coordinated runs persist their enforced wall-clock deadline here.
--
-- Existing active rows predate deadline assignment. Backfill them to the
-- platform's conservative 15-minute ceiling so migration cannot prematurely
-- expire a legitimate long-running agent or prompt chain.
-- ============================================================================

ALTER TABLE tool_executions
  ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMP;

UPDATE tool_executions
   SET deadline_at = started_at + INTERVAL '15 minutes'
 WHERE deadline_at IS NULL
   AND assistant_architect_id IS NOT NULL
   AND status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_tool_executions_active_assistant_deadline
  ON tool_executions (assistant_architect_id, deadline_at)
  WHERE status IN ('pending', 'running');

COMMENT ON COLUMN tool_executions.deadline_at IS
  'Immutable enforced wall-clock deadline for coordinated Assistant Architect executions';
