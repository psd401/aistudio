-- Migration: Update model_replacement_audit table for Nexus architecture
-- Description: Adds columns for new reference types and deprecates old conversations column
-- Related: Issue #501, PR #505
-- Date: 2025-01-XX

-- Add new columns for Nexus architecture reference tracking
ALTER TABLE model_replacement_audit
ADD COLUMN IF NOT EXISTS nexus_messages_updated INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS nexus_conversations_updated INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS tool_executions_updated INTEGER DEFAULT 0;

-- Rename old conversations column to legacy_conversations (deprecated)
-- Keep it for historical data but mark as deprecated
ALTER TABLE model_replacement_audit
RENAME COLUMN conversations_updated TO legacy_conversations_updated;

-- Add comment to document the change
COMMENT ON COLUMN model_replacement_audit.legacy_conversations_updated IS
'DEPRECATED: Used for old chat system. Replaced by nexus_messages_updated and nexus_conversations_updated.';

COMMENT ON COLUMN model_replacement_audit.nexus_messages_updated IS
'Count of nexus_messages records updated during model replacement';

COMMENT ON COLUMN model_replacement_audit.nexus_conversations_updated IS
'Count of nexus_conversations records updated during model replacement (via model_used varchar match)';

COMMENT ON COLUMN model_replacement_audit.tool_executions_updated IS
'Count of assistant architects (linked to tool_executions) updated during model replacement';
