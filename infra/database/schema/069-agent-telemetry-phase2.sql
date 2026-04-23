-- Migration 069: Agent Platform Telemetry Phase 2
-- Part of #890 — Agent Telemetry, Admin Dashboard, Organizational Nervous System
--
-- Adds:
--   agent_messages.topic         — fixed-taxonomy topic label, NULL for [private] / classifier miss
--   agent_health_snapshots       — daily per-user workspace health (written by agent-health-daily Lambda)
--   agent_patterns               — weekly cross-building topic convergence (written by agent-pattern-scanner Lambda)
--
-- Privacy guarantee on agent_patterns: stores topic + building + counts only.
-- No user identity, no message content. Matches the DynamoDB signal store contract.

-- Note: no migration_log reset guard here. The IF NOT EXISTS / ADD COLUMN
-- IF NOT EXISTS guards below make this migration idempotent on its own.
-- A prior failure should surface, not be silently cleared.

-- 1. Topic column on agent_messages
ALTER TABLE agent_messages
    ADD COLUMN IF NOT EXISTS topic VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_agent_messages_topic
    ON agent_messages (topic, created_at DESC)
    WHERE topic IS NOT NULL;

-- 2. agent_health_snapshots: one row per user per day from the daily health Lambda
CREATE TABLE IF NOT EXISTS agent_health_snapshots (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    snapshot_date       DATE NOT NULL,
    user_email          VARCHAR(255) NOT NULL,
    workspace_prefix    VARCHAR(255) NOT NULL,
    workspace_bytes     BIGINT NOT NULL DEFAULT 0,
    object_count        INTEGER NOT NULL DEFAULT 0,
    skill_count         INTEGER NOT NULL DEFAULT 0,
    memory_file_count   INTEGER NOT NULL DEFAULT 0,
    last_activity_at    TIMESTAMPTZ,
    days_inactive       INTEGER,
    abandoned           BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One snapshot per user per day. Re-runs of the Lambda update in place.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_health_unique
    ON agent_health_snapshots (snapshot_date, user_email);

CREATE INDEX IF NOT EXISTS idx_agent_health_abandoned
    ON agent_health_snapshots (snapshot_date DESC, abandoned)
    WHERE abandoned = true;

-- 3. agent_patterns: cross-building topic convergence detected by weekly scanner.
-- No user identity. Week is the ISO week of detection.
CREATE TABLE IF NOT EXISTS agent_patterns (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    week                VARCHAR(10) NOT NULL,
    topic               VARCHAR(64) NOT NULL,
    signal_count        INTEGER NOT NULL,
    building_count      INTEGER NOT NULL,
    rolling_avg         REAL NOT NULL,
    spike_ratio         REAL NOT NULL,
    is_emerging         BOOLEAN NOT NULL DEFAULT false,
    buildings           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_patterns_week
    ON agent_patterns (week DESC, topic);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_patterns_unique
    ON agent_patterns (week, topic);
