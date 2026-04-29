-- Migration 065: Agent Platform Telemetry Tables
-- Part of #888 — Agent Message Pipeline
--
-- Creates three tables for tracking agent platform usage:
--   agent_messages  — per-message telemetry (tokens, latency, model, guardrail status)
--   agent_sessions  — session-level aggregates
--   agent_feedback  — user feedback (thumbs up/down) on individual messages
--
-- NOTE: No PL/pgSQL triggers — the RDS Data API migration runner cannot
-- execute CREATE FUNCTION (dollar-quoting or single-quote style both fail).
-- The updated_at column on agent_sessions is maintained by the Router Lambda's
-- ON CONFLICT DO UPDATE SET session_end = NOW() clause.

-- Mark any previous failed attempts as completed so the runner stops retrying.
UPDATE migration_log SET status = 'completed'
WHERE description = '065-agent-telemetry-tables.sql' AND status = 'failed';

-- agent_messages: One row per message processed by the Router Lambda
CREATE TABLE IF NOT EXISTS agent_messages (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         VARCHAR(255) NOT NULL,
    session_id      VARCHAR(512) NOT NULL,
    model           VARCHAR(128),
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    latency_ms      INTEGER NOT NULL DEFAULT 0,
    guardrail_blocked BOOLEAN NOT NULL DEFAULT false,
    space_name      VARCHAR(512),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_user_id
    ON agent_messages (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_messages_created_at
    ON agent_messages (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_messages_guardrail_blocked
    ON agent_messages (guardrail_blocked, created_at DESC)
    WHERE guardrail_blocked = true;

-- agent_sessions: Session-level aggregates, updated on each message
CREATE TABLE IF NOT EXISTS agent_sessions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         VARCHAR(255) NOT NULL,
    session_id      VARCHAR(512) NOT NULL UNIQUE,
    session_start   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_end     TIMESTAMPTZ,
    total_messages  INTEGER NOT NULL DEFAULT 0,
    total_tokens    INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_id
    ON agent_sessions (user_id, session_start DESC);

-- agent_feedback: User reactions to agent messages
CREATE TABLE IF NOT EXISTS agent_feedback (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         VARCHAR(255) NOT NULL,
    message_id      BIGINT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
    thumbs_up       BOOLEAN NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_feedback_unique
    ON agent_feedback (user_id, message_id);

CREATE INDEX IF NOT EXISTS idx_agent_feedback_message_id
    ON agent_feedback (message_id);
