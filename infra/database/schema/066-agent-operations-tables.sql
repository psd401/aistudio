-- Migration 066: Agent Operations Tables
-- Part of #889 — Agent Operations: Scheduling, Governance, Agent-to-Agent
--
-- Creates tables for tracking:
--   agent_scheduled_runs  — history of scheduled cron executions
--   agent_interagent_log  — inter-agent message audit trail
--   agent_policy_events   — Cedar governance enforcement events
--
-- NOTE: These tables are pre-provisioned for audit/observability. Write paths
-- will be added incrementally: cron telemetry in a follow-up to #889, interagent
-- and policy logging once AgentCore Cedar integration is wired.
-- All tables use CREATE TABLE IF NOT EXISTS for idempotent re-runs.

-- agent_scheduled_runs: Tracks each scheduled cron execution (morning briefs, etc.)
CREATE TABLE IF NOT EXISTS agent_scheduled_runs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         VARCHAR(255) NOT NULL,
    schedule_type   VARCHAR(64) NOT NULL,
    session_id      VARCHAR(512) NOT NULL,
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    latency_ms      INTEGER NOT NULL DEFAULT 0,
    status          VARCHAR(32) NOT NULL DEFAULT 'success',
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_scheduled_runs_user
    ON agent_scheduled_runs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_scheduled_runs_type
    ON agent_scheduled_runs (schedule_type, created_at DESC);

-- agent_interagent_log: Audit trail for agent-to-agent communication
CREATE TABLE IF NOT EXISTS agent_interagent_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sender_bot_id   VARCHAR(512) NOT NULL,
    target_bot_id   VARCHAR(512),
    space_name      VARCHAR(512) NOT NULL,
    thread_name     VARCHAR(512),
    message_preview VARCHAR(500),
    rate_limited    BOOLEAN NOT NULL DEFAULT false,
    anti_loop_blocked BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_interagent_sender
    ON agent_interagent_log (sender_bot_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_interagent_space
    ON agent_interagent_log (space_name, created_at DESC);

-- agent_policy_events: Cedar governance enforcement events
-- Records when policies block or modify agent tool calls
CREATE TABLE IF NOT EXISTS agent_policy_events (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         VARCHAR(255) NOT NULL,
    session_id      VARCHAR(512),
    action          VARCHAR(128) NOT NULL,
    resource_type   VARCHAR(128),
    resource_id     VARCHAR(512),
    policy_decision VARCHAR(32) NOT NULL,
    policy_name     VARCHAR(256),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_policy_user
    ON agent_policy_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_policy_decision
    ON agent_policy_events (policy_decision, created_at DESC);
