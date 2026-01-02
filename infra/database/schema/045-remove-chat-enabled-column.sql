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

-- Safety check: Verify the new columns exist before dropping the old one
DO $$
BEGIN
  -- Check that nexus_enabled and architect_enabled columns exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_models' AND column_name = 'nexus_enabled'
  ) THEN
    RAISE EXCEPTION 'nexus_enabled column does not exist - migration 044 must be applied first';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_models' AND column_name = 'architect_enabled'
  ) THEN
    RAISE EXCEPTION 'architect_enabled column does not exist - migration 044 must be applied first';
  END IF;
END $$;

-- Drop the deprecated chat_enabled column
ALTER TABLE ai_models
  DROP COLUMN IF EXISTS chat_enabled;

-- Add a comment documenting the change
COMMENT ON TABLE ai_models IS 'AI model configurations. Feature availability controlled by nexus_enabled and architect_enabled columns (Epic #582).';
