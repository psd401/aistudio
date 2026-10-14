-- Migration 188: Record that a schedule's owner was told it is failing (#1890).
--
-- The owner-notice rule needs ONE message per failure streak. The first
-- implementation inferred "already told" from the streak's LENGTH — it fired
-- on the run that made the streak exactly three long and stayed quiet after.
-- That is wrong in the direction that matters, twice over:
--
--   1. A schedule already failing when this shipped has a streak far longer
--      than three on its very next run, so it reads as "already told" and the
--      owner is never messaged at all. That is precisely the ~30 staff #1890
--      was opened for — the feature would have skipped its own population.
--   2. If the DM itself fails to send, the length rule still counts that run
--      as the one that spoke, and the schedule goes quiet until it succeeds.
--
-- A nullable timestamp on the run that actually carried the message makes the
-- suppression a fact instead of an inference, and lets the rule become
-- "streak >= 3 and nobody has been told yet", which is correct for a streak of
-- any length and whatever its history.
--
-- Also adds the composite index the streak count needs. `list` asks for every
-- schedule's consecutive-failure count on each call, and a window function
-- partitioned by schedule must materialize the owner's matching rows before
-- counting them. The existing indexes cover (user_id, created_at) and
-- (schedule_id, created_at) separately; neither lets an owner's rows be
-- narrowed by schedule and date together, so an owner running several
-- five-minute schedules would have had the whole 90-day window read per call.
--
-- Migrations 001-005 are untouched (postgres-owned); agent_scheduled_runs was
-- created in migration 066 and is owned by the migration role.
--
-- Rollback:
-- DROP INDEX IF EXISTS idx_agent_scheduled_runs_owner_schedule;
-- ALTER TABLE agent_scheduled_runs DROP COLUMN IF EXISTS owner_notified_at;

ALTER TABLE agent_scheduled_runs
    ADD COLUMN IF NOT EXISTS owner_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN agent_scheduled_runs.owner_notified_at IS
    'When the schedule owner was sent the Chat message saying this schedule is failing (#1890). Set on the one run of a failure streak that carried the message; NULL on every other run. Read as the streak suppression state, so a streak that has any non-NULL value in it stays quiet until the schedule succeeds again.';

CREATE INDEX IF NOT EXISTS idx_agent_scheduled_runs_owner_schedule
    ON agent_scheduled_runs (user_id, schedule_id, created_at DESC);

UPDATE migration_log SET status = 'completed'
WHERE description = '188-agent-schedule-owner-notified.sql' AND status = 'failed';
