-- Migration 063: Add settings JSONB column to prompt_library
-- Stores model, tools, and connector configuration for prompts
-- Also adds prompt_library_updated column to model_replacement_audit

ALTER TABLE prompt_library ADD COLUMN IF NOT EXISTS settings JSONB;

CREATE INDEX IF NOT EXISTS idx_prompt_library_settings_model
ON prompt_library ((settings->>'modelId'))
WHERE settings IS NOT NULL AND settings->>'modelId' IS NOT NULL;

ALTER TABLE model_replacement_audit ADD COLUMN IF NOT EXISTS prompt_library_updated INTEGER DEFAULT 0;
