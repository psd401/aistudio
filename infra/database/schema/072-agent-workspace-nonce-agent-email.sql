-- Migration 072: Add agent_email to consent nonces; remove JWT-as-state
-- Part of #912 review fix — security hardening
--
-- Background: previously the OAuth `state` parameter carried the full
-- consent JWT (sub, agent, purpose, nonce, exp, iat, signature). The state
-- parameter is logged by Google, our access logs, and visible in browser
-- history + HTTP Referer headers. A JWT in those places is more leakage
-- than necessary — the nonce alone is sufficient as a one-time replay
-- guard, *if* the callback can recover owner_email and agent_email from
-- the nonce row.
--
-- This migration adds agent_email so the callback can look up both
-- emails from the nonce alone, dropping the JWT from the OAuth state.

-- Mark previous failed attempts as completed.
UPDATE migration_log SET status = 'completed'
WHERE description = '072-agent-workspace-nonce-agent-email.sql' AND status = 'failed';

ALTER TABLE psd_agent_workspace_consent_nonces
    ADD COLUMN IF NOT EXISTS agent_email VARCHAR(255);

-- Backfill any existing rows. They were created with the old code path
-- (no agent_email), but the JWT verification still validates the row,
-- so derive agent_email from owner_email's local-part rule.
UPDATE psd_agent_workspace_consent_nonces
SET agent_email = 'agnt_' || split_part(owner_email, '@', 1) || '@' || split_part(owner_email, '@', 2)
WHERE agent_email IS NULL;

-- Going forward, agent_email is required. Existing rows are now backfilled.
ALTER TABLE psd_agent_workspace_consent_nonces
    ALTER COLUMN agent_email SET NOT NULL;
