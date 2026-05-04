-- Migration 076: Agent Failures Telemetry Table
--
-- Captures agent execution failures from all chokepoints so we can systemically
-- triage recurring problems instead of grepping CloudWatch.
--
-- Sources:
--   router            — agent-router Lambda (SQS handler, parse errors, AgentCore invoke errors)
--   harness           — agent-image harness_adapter.py (empty responses, exceptions, tool errors)
--   cron              — agent-cron Lambda (mirrors agent_scheduled_runs error rows)
--   agent_self_report — agent self-flagged via the report_failure tool
--   tool              — reserved for future tool-level capture
--
-- Severities: 'error' | 'warn' | 'empty_response'

UPDATE migration_log SET status = 'completed'
WHERE description = '076-agent-failures.sql' AND status = 'failed';

CREATE TABLE IF NOT EXISTS agent_failures (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source            VARCHAR(32) NOT NULL
                      CHECK (source IN ('router','harness','cron','agent_self_report','tool')),
    severity          VARCHAR(16) NOT NULL
                      CHECK (severity IN ('error','warn','empty_response')),
    user_id           VARCHAR(255),
    session_id        VARCHAR(512),
    schedule_name     VARCHAR(255),
    model             VARCHAR(128),
    error_class       VARCHAR(128),
    error_message     TEXT,
    stack_excerpt     TEXT,
    context           JSONB,
    acknowledged      BOOLEAN NOT NULL DEFAULT false,
    acknowledged_by   VARCHAR(255),
    acknowledged_at   TIMESTAMPTZ,
    notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_failures_occurred_at
    ON agent_failures (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_failures_source
    ON agent_failures (source, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_failures_user
    ON agent_failures (user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_failures_unack
    ON agent_failures (occurred_at DESC)
    WHERE acknowledged = false;

CREATE INDEX IF NOT EXISTS idx_agent_failures_severity
    ON agent_failures (severity, occurred_at DESC);

-- agent_pattern_scan_runs: audit log of each weekly scan invocation.
-- Lets the admin dashboard distinguish "scanner never ran" from
-- "scanner ran but everything was below the suppression threshold".
CREATE TABLE IF NOT EXISTS agent_pattern_scan_runs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    week            VARCHAR(16) NOT NULL,
    signals_total   INTEGER NOT NULL DEFAULT 0,
    topics_total    INTEGER NOT NULL DEFAULT 0,
    detected        INTEGER NOT NULL DEFAULT 0,
    suppressed      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_pattern_scan_runs_run_at
    ON agent_pattern_scan_runs (run_at DESC);

-- agent_health_scan_runs: same idea for the daily health Lambda.
CREATE TABLE IF NOT EXISTS agent_health_scan_runs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    snapshot_date   DATE NOT NULL,
    users_total     INTEGER NOT NULL DEFAULT 0,
    abandoned       INTEGER NOT NULL DEFAULT 0,
    error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_health_scan_runs_run_at
    ON agent_health_scan_runs (run_at DESC);
