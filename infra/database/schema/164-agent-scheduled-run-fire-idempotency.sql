-- ============================================================================
-- 164 — Per-fire scheduled telemetry idempotency
--
-- A Scheduler occurrence can be redelivered after its primary run row commits
-- but before the DynamoDB fire marker reaches "completed". Persist the immutable
-- Scheduler fire key so those retries update one run/failure record instead of
-- appending duplicate history.
-- ============================================================================

ALTER TABLE agent_scheduled_runs
  ADD COLUMN IF NOT EXISTS fire_key VARCHAR(192);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_scheduled_runs_fire
  ON agent_scheduled_runs (fire_key)
  WHERE fire_key IS NOT NULL;

ALTER TABLE agent_failures
  ADD COLUMN IF NOT EXISTS fire_key VARCHAR(192);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_failures_source_fire
  ON agent_failures (source, fire_key)
  WHERE fire_key IS NOT NULL;

COMMENT ON COLUMN agent_scheduled_runs.fire_key IS
  'Immutable EventBridge Scheduler occurrence key used for telemetry upserts';

COMMENT ON COLUMN agent_failures.fire_key IS
  'Immutable scheduled occurrence key used to deduplicate mirrored failures';
