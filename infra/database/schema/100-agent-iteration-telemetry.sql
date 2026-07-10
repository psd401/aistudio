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
--      the harness made in this turn. Sourced in agentcore_wrapper.py: the
--      mantle_proxy `usage_events` delta when the proxy is in the serving path,
--      else (the current direct-Mantle path, #1159, where the proxy is bypassed)
--      a harness-derived count = one call per tool round + the final response
--      (len(tool_calls) + 1). Powers the dashboard's avg/p95 model-calls-per-turn
--      aggregates and the trace-export.
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
-- (the migration role cannot ALTER objects owned by postgres, i.e. the
-- 001-005 tables/types, but 065-owned tables like this one are fine).

ALTER TABLE agent_messages
  ADD COLUMN IF NOT EXISTS model_call_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_messages
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_messages
  ADD COLUMN IF NOT EXISTS nudged BOOLEAN NOT NULL DEFAULT false;
