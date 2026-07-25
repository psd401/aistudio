-- Migration 137: Nexus conversation retention + Keep flag (Issue #1330)
--
-- Adds the user-facing "Keep" signal and the admin-configurable retention
-- window that the nightly nexus-conversation-retention Lambda sweeps against.
--
-- Ships DISABLED: the seeded NEXUS_CONVERSATION_RETENTION_DAYS value is empty,
-- which the sweep treats as "retention off" and exits as a no-op. Retention is
-- enabled manually in /admin/settings after user communications go out.
--
-- Eligibility for deletion (implemented in the Lambda, indexed here):
--   is_saved = false AND is_pinned IS NOT TRUE
--   AND last_message_at < (now() AT TIME ZONE 'UTC') - retention_days
-- Archived conversations ARE eligible — archiving is not protection, Keep is.

-- Keep flag. NOT NULL DEFAULT false so the sweep predicate never has to reason
-- about a third state; existing conversations intentionally start unkept.
--
-- Lock note: PostgreSQL 11+ stores a constant DEFAULT as catalog metadata
-- instead of rewriting the table, so this takes only a brief ACCESS EXCLUSIVE
-- lock to update the catalog, not one held for a full rewrite.
ALTER TABLE nexus_conversations
  ADD COLUMN IF NOT EXISTS is_saved BOOLEAN NOT NULL DEFAULT false;

-- Partial index supporting the nightly sweep scan. The predicate is written to
-- match the Lambda's WHERE clause exactly so the planner can use it, and uses
-- `is_pinned IS NOT TRUE` rather than `= false` because is_pinned is nullable
-- (028-nexus-schema.sql declares it BOOLEAN DEFAULT FALSE, not NOT NULL) and a
-- NULL must count as "not pinned" instead of silently dropping the row from
-- both the index and the sweep.
--
-- Built non-CONCURRENTLY, matching every other index in this migration set:
-- CREATE INDEX CONCURRENTLY cannot run inside the transaction the migration
-- runner uses. It takes a SHARE lock that blocks writes to nexus_conversations
-- for the duration of the build — acceptable for a single-column partial btree
-- over a table of this size, but worth knowing before a prod deploy.
--
-- Verified with EXPLAIN on the local database that the planner matches this
-- predicate to the sweep's WHERE clause: the scan reports
-- "Index Scan using idx_nexus_conversations_retention_sweep" with is_saved and
-- is_pinned absorbed into the index predicate rather than left as a filter.
CREATE INDEX IF NOT EXISTS idx_nexus_conversations_retention_sweep
  ON nexus_conversations (last_message_at)
  WHERE is_saved = false AND is_pinned IS NOT TRUE;

-- Retention window. Empty value = disabled. Category matches the existing
-- NEXUS_ATTACHMENT_RETENTION_DAYS entry seeded by 116 so both Nexus retention
-- controls group together in the admin settings UI.
INSERT INTO settings (key, value, description, category, is_secret)
VALUES (
  'NEXUS_CONVERSATION_RETENTION_DAYS',
  '',
  'Days since the last message before a Nexus conversation is permanently deleted. Empty or 0 disables auto-deletion. Conversations marked Keep (or pinned) are never deleted; archived conversations are.',
  'Content Platform',
  false
)
ON CONFLICT (key) DO NOTHING;
