-- Migration 067: Agent Schedules — per-user schedule tracking columns
-- Part of #889 rework — per-user EventBridge Scheduler architecture.
--
-- Adds schedule_id and schedule_name to agent_scheduled_runs so we can link
-- each run back to the specific user-defined schedule that triggered it.
-- The legacy schedule_type column becomes nullable (kept for backfill, no
-- longer written) since schedules are user-defined, not hardcoded types.

ALTER TABLE agent_scheduled_runs
    ADD COLUMN IF NOT EXISTS schedule_id    VARCHAR(64),
    ADD COLUMN IF NOT EXISTS schedule_name  VARCHAR(256);

ALTER TABLE agent_scheduled_runs
    ALTER COLUMN schedule_type DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_scheduled_runs_schedule
    ON agent_scheduled_runs (schedule_id, created_at DESC);
