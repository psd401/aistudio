-- Migration 176: persist the agent turn's usage-capture completeness flag
--
-- WHY THIS EXISTS
-- OpenClaw 2026.7.2-beta.5 moved per-session transcripts out of JSONL files
-- into a per-agent SQLite database. The harness adapter kept reading the old
-- JSONL path, so from 2026-07-31 (dev) / 2026-08-01 (prod) every turn recorded
-- input_tokens = output_tokens = cache_read_input_tokens = 0. Nothing failed:
-- a zero read is indistinguishable from an honest zero once it reaches this
-- table, so the admin/agents Cost tab quietly showed $0 for ten days.
--
-- The wrapper ALREADY computed a `usage_capture_complete` boolean for exactly
-- this purpose (agentcore_wrapper.usage_capture_is_complete) — but only the
-- eval harness ever consumed it. Production turns dropped it on the floor,
-- which is why the outage had no persisted signal to alarm on or query.
-- This column keeps it.
--
-- NULLABLE ON PURPOSE. Unlike the token columns this is not "0 when absent":
--   TRUE  = the harness (or the proxy) positively measured this turn's usage.
--   FALSE = the turn ended without a complete usage read; the token columns
--           are a floor, not a total. THIS IS THE OUTAGE SIGNATURE.
--   NULL  = unknown — the row predates this column, or the reporting image is
--           older than it. A default of TRUE would silently assert that ten
--           days of all-zero rows were fully measured, and a default of FALSE
--           would flag every historical row as suspect. Neither is true, so
--           the honest value is "we do not know".
--
-- Safe to re-run.

ALTER TABLE agent_messages
  ADD COLUMN IF NOT EXISTS usage_capture_complete BOOLEAN;

COMMENT ON COLUMN agent_messages.usage_capture_complete IS
  'TRUE = token usage was positively measured for this turn; FALSE = the usage '
  'read did not complete, so the token columns are a floor rather than a total '
  '(the 2026-07-31 JSONL-to-SQLite transcript regression); NULL = unknown, the '
  'row predates the column or the reporting agent image does.';

-- Partial index: the only queries that need this column look for the failure
-- case, which is a small minority of rows in a healthy system. A full index
-- would be mostly dead weight on the hot insert path.
CREATE INDEX IF NOT EXISTS idx_agent_messages_usage_capture_incomplete
  ON agent_messages (created_at)
  WHERE usage_capture_complete IS FALSE;
