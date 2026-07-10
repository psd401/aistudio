-- Migration 100: Agent-platform iteration telemetry
-- Part of #1161 (Make the agent platform self-improving — Loop 2 measurement half)
--
-- Adds three additive per-turn columns to agent_messages (migration 065 table,
-- previously extended by 092) so the harness's iteration behavior becomes
-- measurable instead of hand-discovered. The #1138 finding was a 47-model-call,
-- 14.5-minute turn for a check-and-report task, found by reading logs by hand;
-- you cannot improve instructions you cannot measure.
--
--   1. model_call_count — number of upstream model calls (Mantle round-trips)
--      the harness made in this turn. Captured by mantle_proxy.py's cumulative
--      `usage_events` counter and threaded as a before/after delta through
--      agentcore_wrapper.py -> agent-router (the exact same delta mechanism 092
--      used for cache_read/write tokens). Powers the dashboard's avg/p95
--      model-calls-per-turn aggregates.
--
--   2. duration_ms — wall-clock milliseconds for the whole turn, measured in
--      the wrapper from invocation_start to the final yield. This is DISTINCT
--      from the existing latency_ms column, which is the harness's chat.send ->
--      final latency; duration_ms includes the wrapper's proxy reads, the
--      empty-turn nudge retry, and any tool time the harness excludes.
--
--   3. nudged — TRUE when the empty-turn nudge fired at least once this turn
--      (harness_adapter.py sends one follow-up when a turn does tool work but
--      produces no user-visible text). Powers the dashboard's nudge-fire rate —
--      a "platform compensating for model behavior" signal whose TREND is the
--      input to Loop-2 instruction rewrites. A recovered-after-nudge turn
--      records NO agent_failures row, so nudged is the only persisted signal of
--      an empty-final that the nudge recovered (empty-turn rate, by contrast, is
--      derived from agent_failures.severity='empty_response' = stayed empty).
--
-- ADDITIVE and idempotent. New columns with defaults, no backfill required. No
-- DO $$ blocks (the migration runner's statement splitter cannot handle
-- dollar-quoted blocks -- see migration 079). agent_messages is owned by the
-- migration role (created in 065), so ALTER TABLE ADD COLUMN is permitted
-- (unlike the postgres-owned 001-005 objects — see 2026-07 owner-privilege
-- learning).

ALTER TABLE agent_messages
  ADD COLUMN IF NOT EXISTS model_call_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_messages
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_messages
  ADD COLUMN IF NOT EXISTS nudged BOOLEAN NOT NULL DEFAULT false;
