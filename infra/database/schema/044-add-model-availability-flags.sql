-- Migration: Add nexus_enabled and architect_enabled columns to ai_models
-- Part of Epic #582 - Feature-specific model availability flags
-- Issue #584

-- Add new availability columns with defaults
ALTER TABLE ai_models
  ADD COLUMN IF NOT EXISTS nexus_enabled BOOLEAN DEFAULT true NOT NULL;

ALTER TABLE ai_models
  ADD COLUMN IF NOT EXISTS architect_enabled BOOLEAN DEFAULT true NOT NULL;

-- Migrate existing chatEnabled to both new flags
-- All existing models get their chat_enabled value copied to both new flags
-- This preserves existing behavior during the transition period
UPDATE ai_models
SET nexus_enabled = chat_enabled,
    architect_enabled = chat_enabled;

-- Note: DO NOT drop chat_enabled yet - keep for backward compatibility during transition
-- chat_enabled removal will be a separate P2 issue after all code references are updated
