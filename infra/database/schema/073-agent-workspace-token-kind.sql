-- Migration 073: Add token_kind discriminator for dual-connection model
-- Part of #912 Phase 1 — agent reads user's own Gmail/Tasks/Drive via the
-- user's own narrow OAuth scopes (separate from the agent account's broad
-- consent). Each user can now have up to two rows in
-- psd_agent_workspace_tokens, distinguished by token_kind.
--
-- token_kind values:
--   'agent_account' — OAuth on agnt_<uniqname>@psd401.net (existing flow,
--                     used for Calendar via sharing, Drive ownership, Chat
--                     presence, future agent-as-itself sends).
--   'user_account'  — OAuth on hagelk@psd401.net itself (new flow,
--                     narrow scopes: gmail.readonly, gmail.compose, tasks,
--                     drive.file). Used to read the human's own data.
--
-- The previous unique constraint on owner_user_id alone is replaced with a
-- composite (owner_user_id, token_kind) so both rows can coexist per user.

UPDATE migration_log SET status = 'completed'
WHERE description = '073-agent-workspace-token-kind.sql' AND status = 'failed';

-- Add the column with a temporary default so the existing rows don't violate
-- NOT NULL during the ADD COLUMN step.
ALTER TABLE psd_agent_workspace_tokens
    ADD COLUMN IF NOT EXISTS token_kind VARCHAR(16) NOT NULL DEFAULT 'agent_account'
    CHECK (token_kind IN ('agent_account', 'user_account'));

-- Drop the temporary default — rows must explicitly set token_kind going forward.
ALTER TABLE psd_agent_workspace_tokens
    ALTER COLUMN token_kind DROP DEFAULT;

-- Replace the old unique-on-owner_user_id index with a composite that allows
-- one row per (user, kind). The old index name is preserved if it exists;
-- we drop it explicitly and recreate as composite.
DROP INDEX IF EXISTS idx_agent_workspace_tokens_owner;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workspace_tokens_owner_kind
    ON psd_agent_workspace_tokens (owner_user_id, token_kind);

-- Add kind to consent nonces too so the OAuth callback knows which slot
-- to write to (the state parameter is just the bare nonce — see migration 072
-- for why we don't carry the full JWT in OAuth state).
ALTER TABLE psd_agent_workspace_consent_nonces
    ADD COLUMN IF NOT EXISTS token_kind VARCHAR(16) NOT NULL DEFAULT 'agent_account'
    CHECK (token_kind IN ('agent_account', 'user_account'));

ALTER TABLE psd_agent_workspace_consent_nonces
    ALTER COLUMN token_kind DROP DEFAULT;
