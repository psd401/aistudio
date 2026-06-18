-- Migration 082: Assistant Architect agentic mode
-- Part of #926 (Epic #922, workstream #4 — Unify Agent Platform)
--
-- Extends Assistant Architect with an opt-in "agentic" runtime: a model loop that
-- can call tools (resolved from the unified tool catalog #924 + per-user MCP
-- connectors #774), reason over the results, and continue until done. The existing
-- "prompt_chain" mode (form inputs -> ordered prompt-template execution -> text)
-- is preserved unchanged and remains the DEFAULT for backward compatibility.
--
-- This migration is ADDITIVE and idempotent. It adds columns to two existing
-- tables; it creates no new tables and drops nothing.
--
--   1. assistant_architects: a `mode` column plus the agentic runtime config
--      (tool list, connector list, step/timeout/cost limits).
--
-- The agentic tool-call audit timeline reuses the EXISTING assistant_event_type
-- enum values `tool-execution-start` / `tool-execution-complete` (migration 037),
-- which were added for exactly this purpose. No enum change is needed — keeping
-- this migration to pure additive ALTER TABLE and avoiding the
-- "ALTER TYPE ADD VALUE cannot run in a transaction block" pitfall.
--
-- NOTE: No PL/pgSQL triggers / DO $$ blocks. The RDS Data API migration runner's
-- statement splitter cannot handle dollar-quoted blocks (see migration 079/080).

-- Mark any previous failed attempts as completed so the runner stops retrying.
UPDATE migration_log SET status = 'completed'
WHERE description = '082-assistant-architect-agentic-mode.sql' AND status = 'failed';

-- 1. assistant_architects agentic-mode columns.
--    `mode` defaults to 'prompt_chain' so every existing row keeps today's
--    behavior with no backfill. A CHECK constraint enforces the two valid values
--    (single-table design per the issue's "mode column for simplicity" decision).
ALTER TABLE assistant_architects
    ADD COLUMN IF NOT EXISTS mode VARCHAR(20) DEFAULT 'prompt_chain' NOT NULL;

ALTER TABLE assistant_architects
    ADD COLUMN IF NOT EXISTS agent_enabled_tools JSONB DEFAULT '[]'::jsonb NOT NULL;

ALTER TABLE assistant_architects
    ADD COLUMN IF NOT EXISTS agent_enabled_connectors JSONB DEFAULT '[]'::jsonb NOT NULL;

ALTER TABLE assistant_architects
    ADD COLUMN IF NOT EXISTS agent_max_steps INTEGER DEFAULT 10 NOT NULL;

ALTER TABLE assistant_architects
    ADD COLUMN IF NOT EXISTS agent_timeout_seconds INTEGER DEFAULT 300 NOT NULL;

-- Per-run cost cap in whole US cents (NULL = no cap). Whole cents avoids float
-- rounding drift across many step usages.
ALTER TABLE assistant_architects
    ADD COLUMN IF NOT EXISTS agent_cost_cap_cents INTEGER;

-- Enforce the two valid modes. Guarded so re-running the migration is a no-op.
-- (Postgres has no ADD CONSTRAINT IF NOT EXISTS; the DROP ... IF EXISTS makes it idempotent.)
ALTER TABLE assistant_architects DROP CONSTRAINT IF EXISTS assistant_architects_mode_check;
ALTER TABLE assistant_architects
    ADD CONSTRAINT assistant_architects_mode_check
    CHECK (mode IN ('prompt_chain', 'agentic'));

-- Guard the step/timeout limits against nonsensical values that would either
-- disable the loop (<=0) or remove the runaway-loop protection (unbounded).
ALTER TABLE assistant_architects DROP CONSTRAINT IF EXISTS assistant_architects_agent_max_steps_check;
ALTER TABLE assistant_architects
    ADD CONSTRAINT assistant_architects_agent_max_steps_check
    CHECK (agent_max_steps BETWEEN 1 AND 50);

ALTER TABLE assistant_architects DROP CONSTRAINT IF EXISTS assistant_architects_agent_timeout_check;
ALTER TABLE assistant_architects
    ADD CONSTRAINT assistant_architects_agent_timeout_check
    CHECK (agent_timeout_seconds BETWEEN 1 AND 900);

ALTER TABLE assistant_architects DROP CONSTRAINT IF EXISTS assistant_architects_agent_cost_cap_check;
ALTER TABLE assistant_architects
    ADD CONSTRAINT assistant_architects_agent_cost_cap_check
    CHECK (agent_cost_cap_cents IS NULL OR agent_cost_cap_cents > 0);

-- 2. Expose the code MCP tools on the `internal` surface so the agentic runtime
--    can resolve them via the catalog. The boot-time manifest sync also does this
--    (it reconciles `surfaces` from lib/tools/catalog/manifest.ts), but seeding it
--    here keeps a freshly migrated DB correct even before the first sync runs.
--    Only append 'internal' when absent so this stays idempotent and does not
--    clobber the 'rest' surface that execute_assistant / list_assistants carry.
UPDATE tool_catalog
SET surfaces = surfaces || '["internal"]'::jsonb
WHERE source = 'code'
  AND identifier IN (
    'decisions.search', 'decisions.capture', 'assistants.execute',
    'assistants.list', 'decisions.graph_get'
  )
  AND NOT (surfaces @> '["internal"]'::jsonb);
