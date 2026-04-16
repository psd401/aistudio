-- Migration 065: Agent Platform Telemetry Tables
-- Part of #888 — Agent Message Pipeline
--
-- Creates three tables for tracking agent platform usage:
--   agent_messages  — per-message telemetry (tokens, latency, model, guardrail status)
--   agent_sessions  — session-level aggregates
--   agent_feedback  — user feedback (thumbs up/down) on individual messages

-- agent_messages: One row per message processed by the Router Lambda
CREATE TABLE IF NOT EXISTS agent_messages (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         VARCHAR(255) NOT NULL,       -- Google Workspace email
    session_id      VARCHAR(512) NOT NULL,       -- AgentCore session identifier
    model           VARCHAR(128),                -- Model used (e.g., kimi-k2.5), NULL for guardrail blocks/errors
    input_tokens    INTEGER NOT NULL DEFAULT 0,
    output_tokens   INTEGER NOT NULL DEFAULT 0,
    latency_ms      INTEGER NOT NULL DEFAULT 0,  -- End-to-end Router Lambda latency
    guardrail_blocked BOOLEAN NOT NULL DEFAULT false,
    space_name      VARCHAR(512),                -- Google Chat space identifier
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying by user (admin dashboards, usage reports)
CREATE INDEX IF NOT EXISTS idx_agent_messages_user_id
    ON agent_messages (user_id, created_at DESC);

-- Index for querying by time range (aggregate reporting)
CREATE INDEX IF NOT EXISTS idx_agent_messages_created_at
    ON agent_messages (created_at DESC);

-- Index for guardrail violation reporting
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

-- Index for looking up active sessions by user
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_id
    ON agent_sessions (user_id, session_start DESC);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_agent_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_agent_sessions_updated_at ON agent_sessions;
CREATE TRIGGER trigger_agent_sessions_updated_at
    BEFORE UPDATE ON agent_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_agent_sessions_updated_at();


-- agent_feedback: User reactions to agent messages
-- Design: One feedback per user per message (unique constraint below).
-- Feedback is immutable by design — to change a reaction, delete and re-insert.
-- This simplifies audit trails and prevents accidental overwrites.
CREATE TABLE IF NOT EXISTS agent_feedback (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         VARCHAR(255) NOT NULL,
    message_id      BIGINT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
    thumbs_up       BOOLEAN NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One feedback per user per message
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_feedback_unique
    ON agent_feedback (user_id, message_id);

-- Index for aggregate feedback queries
CREATE INDEX IF NOT EXISTS idx_agent_feedback_message_id
    ON agent_feedback (message_id);
