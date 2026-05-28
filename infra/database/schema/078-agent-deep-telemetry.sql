-- Migration 078: Deep telemetry for the Agent Platform.
-- ---------------------------------------------------------------------------
-- Adds two new tables that let the admin dashboard inspect full conversation
-- content + tool invocations for every agent turn. Drives the Conversations
-- tab. Both tables FK to agent_messages so a single CASCADE delete cleans
-- everything related to a turn.
--
-- Content size limits enforced in the writer:
--   agent_message_content.content_text   — capped at 64KB
--   agent_tool_invocations.tool_args     — capped at 16KB (after stringify)
--   agent_tool_invocations.tool_result   — capped at 16KB (after stringify)
--
-- A separate daily Lambda (agent-telemetry-prune) deletes rows in these
-- tables older than 90 days. The summary rows in agent_messages are kept.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_message_content (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  -- Denormalized to keep the dashboard queries off the FK on hot paths.
  session_id VARCHAR(512) NOT NULL,
  user_email VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content_text TEXT NOT NULL,
  -- True when the writer truncated to the 64KB cap (Postgres TOAST handles
  -- the underlying storage; the flag lets the UI surface "transcript clipped").
  content_truncated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_message_content_message_id
  ON agent_message_content (message_id);
CREATE INDEX IF NOT EXISTS idx_agent_message_content_session
  ON agent_message_content (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_message_content_user
  ON agent_message_content (user_email, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_message_content_created_at
  ON agent_message_content (created_at);


CREATE TABLE IF NOT EXISTS agent_tool_invocations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  session_id VARCHAR(512) NOT NULL,
  user_email VARCHAR(255) NOT NULL,
  tool_name VARCHAR(255) NOT NULL,
  -- JSONB so the dashboard can query inside args (e.g. "all psd-github tool
  -- calls with repo=krishagel/life-os") without a separate index strategy.
  tool_args JSONB,
  tool_result JSONB,
  status VARCHAR(16) NOT NULL CHECK (status IN ('success', 'error', 'timeout')),
  error_text TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  finished_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_invocations_message_id
  ON agent_tool_invocations (message_id);
CREATE INDEX IF NOT EXISTS idx_agent_tool_invocations_tool
  ON agent_tool_invocations (tool_name, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_tool_invocations_session
  ON agent_tool_invocations (session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_tool_invocations_user
  ON agent_tool_invocations (user_email, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_tool_invocations_created_at
  ON agent_tool_invocations (created_at);
