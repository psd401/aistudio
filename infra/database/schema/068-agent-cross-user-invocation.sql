-- Migration 068: Cross-User Agent Invocation Support
-- Part of #903 — Cross-user agent invocation via @agent:username in Google Chat
--
-- Adds invoked_by column to agent_messages for tracking when a user invokes
-- another user's agent. NULL means the agent owner sent the message (normal flow).
-- Also adds agent_owner_id to record whose agent was consulted.

-- agent_messages: track who invoked the agent (NULL = owner)
ALTER TABLE agent_messages
    ADD COLUMN IF NOT EXISTS invoked_by VARCHAR(255),
    ADD COLUMN IF NOT EXISTS agent_owner_id VARCHAR(255);

-- Index for querying cross-user invocations (e.g., "who consulted my agent today?")
CREATE INDEX IF NOT EXISTS idx_agent_messages_invoked_by
    ON agent_messages (agent_owner_id, created_at DESC)
    WHERE invoked_by IS NOT NULL;

-- Index for the agent owner to query their invocation log
CREATE INDEX IF NOT EXISTS idx_agent_messages_agent_owner
    ON agent_messages (agent_owner_id, created_at DESC);
