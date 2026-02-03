-- Migration: Remove deprecated chat_enabled column from ai_models
-- Part of Epic #582 - Feature-specific model availability flags
-- Issue #588 - Remove chat_enabled after migration
--
-- Prerequisites:
--   - Issue #584: Added nexus_enabled and architect_enabled columns (migration 044)
--   - Issue #585: Migrated chatEnabled data to new flags
--   - Issue #586: Updated all code references
--
-- This migration is the final cleanup step that removes the deprecated column.
-- Note: Safety checks rely on DROP COLUMN IF EXISTS (idempotent operation)

-- Drop the deprecated chat_enabled column
ALTER TABLE ai_models
  DROP COLUMN IF EXISTS chat_enabled;

-- Add a comment documenting the change
COMMENT ON TABLE ai_models IS 'AI model configurations. Feature availability controlled by nexus_enabled and architect_enabled columns (Epic #582).';
